---
type: Reference
title: Workflow tools
description: "Workflows over MCP: routes and blockers, the task lock while a workflow runs, save, start, pause, resume and delete, adding, linking and rerouting tasks, and request_project_access for a workflow's own agent."
tags: [mcp, workflows]
sources:
  - resource: src/main/agent/mcp-http/workflow-tools.ts
  - resource: src/main/agent/commands/workflow-commands.ts
---
# Workflow tools

## Workflows

A workflow is a set of linked tasks that run through their boards on their own. Each task has a
**route**, the columns it visits (every column between To Do and Done unless it starts later, ends
earlier, or skips some), and starts when every task it waits for has reached Done. A step finishes
when the column's work is done: the Automation agent judges the agent's final message at each turn
end (or a plan is approved, or the task's own agent moves it with `kangentic_move_task`), and the
task moves to the next column on its route. A column with no agent, an agent that reports no turn
end, or no Automation agent set up is a human gate: a person drags the card on.

While a workflow runs its tasks are locked. Only the workflow, its column automations, plan exit
and a task's OWN agent move them; a drag, the phone or another agent is refused with
"#414 is locked while Usage budgets runs." Nothing moves a workflow task into To Do. Paused, its
cards move by hand except into To Do. So does a task whose automations are paused
(`automationsDisabled`, see [Disabling automations for one
task](../../architecture/automations/triggers.md#disabling-automations-for-one-task)): it is not
locked, and a hand may move it to any column but To Do.

A workflow lives in the project it was made in (pass `project` to reach another). Its tasks can sit
on other registered projects' boards: name the project on the planned task. Of these tools the
phone's board-tool path reaches only list, get, pause and resume; planning, Start and Delete stay
on the desktop (see [Capability verbs](../mobile-bridge/capability-verbs.md#board-tool-surface)).

## kangentic_list_workflows

The project's workflows with their state (not started, running, paused) and progress, newest first.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `includeFinished` | boolean | No | Include workflows whose tasks are all in Done. |
| `project` | string | No | Project name or UUID. Omit for the active project. |

## kangentic_get_workflow

One workflow: its state, its `revision`, and each task with its column, route and what it waits
for. A workflow not started lists its planned tasks by key, each with any run setting that is not
the default, in `kangentic_save_workflow`'s own names (`project "API", baseBranch "develop",
useWorktree false, profile "Heavy"`), so a plan read and sent back keeps them. A planned task
reads `In To Do (created at Start)`, or, when it takes in a board task with `existingTask`, names
that task: `In To Do (#921, taken in at Start)`. A started task on
another project's board says which (`#7 ... In Review on board "API"`), and so does a blocker
there (`Waits for #7 on "API"`), since task numbers count per board. A blocker whose project's
database will not open reads `a task on "API" that could not be read`, and still holds its task. A
link to a deleted task, to one in a removed project, or to one that has left the workflow is left
out: the engine drops it on its next pass. A task a running workflow is stalled on (its recovery
ran out, the low-memory pause stopped it more often than its memory resumes allow, or it cannot
start) ends its line with `Stalled: <why>`,
and so does its `stalled` field. `data`
carries every task's `runSettings` in the task row's shape.

Plan approval is set per task, so an agent learns which way each task goes without reading any
board's columns. A summary line follows the header and brief (`Plan approval: set per task. 1 task
Manual, 2 Automatic; each task's line says why.`, or `Plan approval: set per task (planApproval on
each task). No task's route has a plan column.`), and each task's line ends with its own sentence:

- `Plan approval: Automatic, from kangentic's Planning column.` (left alone, it follows the plan
  columns on its route: Automatic only when every one is Automatic and runs an agent that can
  approve plans)
- `Plan approval: Manual, set for this task (its Planning column is Automatic).`
- `Plan approval: Automatic, set for this task (its Planning column is Manual), but Codex CLI's plans still wait for you.`
  (a route where only some plan columns run an agent Kangentic can approve plans for)
- `Plan approval: Manual, because Kangentic can't approve Codex CLI's plans (its Planning column is Automatic).`
- `Plan approval: none, no plan column on its route.`

A task that has passed its plan column adds ` It has passed Planning, so it can no longer change.`
Before Start, a task's own value is also one of its settings (`planApproval "manual"`), printed
even when its route has no plan column, so a plan read and sent back keeps it. `data` carries each
task's `ownPlanApproval` (what it carries) and `planApproval`: `set` (its own value, or null),
`value`, `columnValue`, `canApprove`, the deciding `column`, `agentName`, `waitingAgentName` and
`passed`, or null with no plan column on its route.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workflow` | string | Yes | The workflow's id or exact title (case-insensitive). |
| `project` | string | No | Project name or UUID. Omit for the active project. |

## kangentic_save_workflow

Save the plan of a workflow that has not started, replacing what it held: its title, every planned
task, and the links. Omit `workflow` to create one. Nothing reaches a board until it starts.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workflow` | string | No | The workflow to replace the plan of. Omit to create a new one. |
| `title` | string | No | Its name. |
| `brief` | string | No | A new workflow only: the text it was made from. |
| `tasks` | array | Yes | Every planned task (at most 100). See below. |
| `links` | array | No | `{ blocker, blocked }` by key: blocked waits for blocker to reach Done. |
| `revision` | number | No | The revision `kangentic_get_workflow` reported. A save over a newer one is refused, so the user's edits win. |
| `planApproval` | | No | Removed: plan approval is set per task. A value is refused with "planApproval is set per task now. Put planApproval on each task entry."; `null` is accepted and ignored, since older `kangentic_get_workflow` output told agents to send it back. |
| `project` | string | No | Project name or UUID. Omit for the active project. |

Each planned task takes `key` (unique in the plan), `title`, `description`, and optionally
`project` (another board, by name), `existingTask` (a To Do task to take in instead of creating
one), `routeStart`, `routeLast`, `skip` (column names), `labels` and `priority`.

It also takes `planApproval`: `automatic` has Kangentic approve the task's plan, so it moves on by
itself (a question the agent asks the user still waits), and `manual` waits for the user. Omitted or
`null`, the task follows the plan columns on its route. The column's own value is stored as nothing,
the same as leaving it unset. It is not a run setting, so a task taken in with `existingTask` may
carry it, and Start copies it onto the task. A value that is neither is refused, naming the task
(`Budgets API: planApproval must be "automatic", "manual", or null.`). After Start, the Workflows
inspector, task detail's Workflow panel and [`kangentic_update_task`](task-tools.md#kangentic_update_task)
change it.

It also takes the run settings a task on the board has, which Start copies onto the task it creates:

| Field | Type | Description |
|-------|------|-------------|
| `baseBranch` | string | The branch its worktree is cut from. Omitted is the board's base branch. |
| `useWorktree` | boolean | `true` for its own worktree, `false` for the project folder. Omitted is the project's setting. |
| `runMode` | string | `column_settings` (the default) or `agent_override`. A pin below implies `agent_override`. |
| `profile` | string | A Board Profile on the task's own board, by name or id. Column Settings only. |
| `agentOverride` | string | A registered agent, pinned for the whole task. |
| `modelOverride` | string | A model, checked against what that agent's CLI offers. |
| `effortOverride` | string | An effort level, checked against that agent's levels. |
| `permissionMode` | string | A permission mode, pinned for the whole task. |

The handler checks each of these itself, since a command can be reached without the tool's
schema. An unknown agent, model, effort or profile is refused with the valid ones, and so is a
profile together with a pin, or `runMode: "column_settings"` with a pin. A task taken in with
`existingTask` keeps its own settings, so it takes none. Every problem is reported before anything
is written: a duplicate key, a column a route cannot use, a link to an unknown key, a loop. That
holds for a new workflow too: a save without `workflow` creates the workflow only with a plan that
passed, in the same write, so a refused one leaves nothing behind. The answer reads "Saved: 9
tasks, 13 links."

## kangentic_start_workflow

Start a planned workflow: its tasks appear in To Do on their boards and each starts on its own when
nothing it waits for is left, up to the free agent slots, in To Do order. A start fetches the base
first, so a task is cut from its blockers' merged code. The task the workflow was made from moves
to Done, unless the plan took it in.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workflow` | string | Yes | The workflow's id or exact title. |
| `project` | string | No | Project name or UUID. Omit for the active project. |

## kangentic_pause_workflow

Pause every agent in a running workflow at once, a task with paused automations included (a
mid-board suspend: nothing is reaped). The workflow then starts, judges and moves nothing until it
is resumed. A person may still work a card meanwhile (resume its agent by hand, drag it), and an
agent resumed by hand may move its own card. A paused agent stays paused through any move: the
destination's On task enter rows that need no agent run, if the task's automations are on, and
the rows that need the agent are recorded as skipped with "The agent is paused. This row runs if
the agent is resumed in this column." The reply counts the agents paused and names each task
whose agent could not be paused; the phone gets the same counts as the result's `paused`,
`notLive` and `failed`.

When a member's own agent makes the call, its own session pauses only after the turn that made the
call ends, and the reply says "Your own session pauses when this turn ends." Every other member
pauses at once. The call and its reply then stay in the agent's conversation, so a later resume of
it does not pause the workflow again. See
[A call that ends the caller's own session](../../architecture/sessions/suspend-and-cleanup.md#a-call-that-ends-the-callers-own-session).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workflow` | string | Yes | The workflow's id or exact title. |
| `project` | string | No | Project name or UUID. Omit for the active project. |

## kangentic_resume_workflow

Resume a paused workflow. Each paused agent resumes in the column its task is in now, in any
working column. When the task entered that column after its agent was paused, the resume does what
that entry would have done: a column that always starts new starts a fresh conversation, one that
resumes brings the conversation back with the column's settings, and then the column's On task
enter rows that need the agent run (not the others, which ran at the entry). A task that has not
changed column since the pause continues the same conversation with no column message. A task in an
agent column with no agent gets one started, with the column's message, unless its automations are
paused. An agent already running is left alone. Waiting tasks
start as their blockers reach Done. The reply counts the agents resumed, started and already
running, and names any that failed; the phone gets them as `resumed`, `started`, `alreadyRunning`
and `failed`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workflow` | string | Yes | The workflow's id or exact title. |
| `project` | string | No | Project name or UUID. Omit for the active project. |

## kangentic_add_workflow_task

Add a task to a started workflow. It lands in To Do and starts once nothing it waits for is left.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workflow` | string | Yes | The workflow's id or exact title. |
| `title` | string | Yes | The task's title. |
| `description` | string | No | What its agent should do. |
| `taskProject` | string | No | Another project's board to put it on. |
| `routeStart` / `routeLast` | string | No | First and last columns it visits. |
| `skip` | string[] | No | Columns inside its route it skips. |
| `waitsFor` | string[] | No | Tasks in this workflow it waits for: a task number on the workflow's own board, or the id of a task on any of its boards. Numbers count per board, so a task on another board is named by its id. |
| `baseBranch`, `useWorktree`, `runMode`, `profile`, `agentOverride`, `modelOverride`, `effortOverride`, `permissionMode` | | No | Its run settings, as [`kangentic_save_workflow`](#kangentic_save_workflow)'s planned tasks take them. The task is created with them. |
| `planApproval` | string \| null | No | Its own plan approval, as a planned task takes it. Omitted or `null` follows the plan columns on its route. |
| `project` | string | No | Project name or UUID. Omit for the active project. |

The run settings go through the same checks and refusals as a save's: the wrong type, an unknown
agent, model, effort or profile (the profile is looked up on the task's own board), a profile
together with a pin, or `runMode: "column_settings"` with a pin. Each refusal names the task by its
title, and nothing is written.

## kangentic_link_workflow_tasks

Make a task in a started workflow wait for another to reach Done. Only a task still in To Do can
wait, only for one not yet done, and a link that closes a loop is refused.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workflow` | string | Yes | The workflow's id or exact title. |
| `blocker` / `blocked` | string | Yes | Task numbers or ids: blocked waits for blocker. |
| `blockerProject` / `blockedProject` | string | No | The project each is on, when not the workflow's. |
| `project` | string | No | Project name or UUID. Omit for the active project. |

## kangentic_unlink_workflow_tasks

Remove a link. A task in To Do whose last blocker this was starts as soon as a slot is free. Same
parameters as `kangentic_link_workflow_tasks`.

## kangentic_set_task_route

Change which columns a task in a started workflow visits. A task in To Do can take any route; one
that has started can change only the columns after the one it is in.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workflow` | string | Yes | The workflow's id or exact title. |
| `task` | string | Yes | Task number or id. |
| `taskProject` | string | No | The project it is on, when not the workflow's. |
| `routeStart` / `routeLast` | string \| null | No | Pass only what changes; null resets to the open end. |
| `skip` | string[] | No | The complete list of columns to skip. |
| `project` | string | No | Project name or UUID. Omit for the active project. |

## kangentic_remove_from_workflow

Take a task out of its workflow. It stays where it is as an ordinary task, and its links are
removed. A task in Done stays with its workflow.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workflow` | string | Yes | The workflow's id or exact title. |
| `task` | string | Yes | Task number or id. |
| `taskProject` | string | No | The project it is on, when not the workflow's. |
| `project` | string | No | Project name or UUID. Omit for the active project. |

## kangentic_request_project_access

For a workflow's own agent: read another registered project's code while planning. It is granted
at once, with no approval, and kept on the workflow (`agent_read_project_ids`), so every later
start and resume reads it too. A running agent picks it up at its next idle: Kangentic resumes it
on the same conversation with that checkout added (Claude's `--add-dir`) and tells it where the
checkout is. The agent already reads every project its workflow's tasks are on, and a checkout
missing from disk is left out. An agent whose CLI cannot widen its reads
(`supportsReadableDirectories`) keeps reading its own project only.

The workflow agent's server instructions name this tool, since Claude Code defers MCP tools when
there are many and the agent then sees only a tool's name until it searches. An agent that does
not find it searches the disk instead, and hits Claude's own permission prompt for a read outside
its directories. They tell the agent to do what the tool's reply says rather than promise a
restart, because any agent can be a workflow's agent and only one whose CLI can widen its reads is
restarted with the checkout readable; the reply says which case applies.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workflow` | string | Yes | The workflow's id or exact title. The workflow's own agent leaves it out. |
| `readProject` | string | Yes | The project to read, by name or id. |
| `project` | string | No | Project name or UUID. Omit for the active project. |

## kangentic_delete_workflow

Delete a workflow. One not started loses its plan and nothing else changes. A started one's
unfinished tasks stay where they are as ordinary tasks, and its tasks in Done stay in Done. Those
Done tasks stay in Done as ordinary tasks once it is deleted.

With `deleteNeverStarted`, the unfinished tasks that never started go too: a task still in To Do
that never had a session, has no worktree, and was never in another column. A move back to To Do
wipes a task's sessions and worktree, so its moves are what keep a task that ran. The workflow is
deleted first, then each such task through the board's own task delete, checked again inside the
task's lock, so a task a drag started meanwhile stays. The reply names the tasks kept and deleted
(`#12 stays where it is, as an ordinary task. Deleted #14 and "API" #3, which never started.`),
and a task whose delete failed, which stays in To Do. A task on another board is named with its
board before its number, so in a list the board names that one task. `data` carries `kept`,
`deleted` and `failed`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workflow` | string | Yes | The workflow's id or exact title. |
| `deleteNeverStarted` | boolean | No | Also delete its tasks that never started. Off by default. |
| `project` | string | No | Project name or UUID. Omit for the active project. |
