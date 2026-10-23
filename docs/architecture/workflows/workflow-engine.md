---
type: Reference
title: Workflow engine
description: "How the workflow engine runs linked tasks: the pure core and its main-process host, wake-ups coalesced to 150 ms with no polling, the boot probe that opens only boards a workflow touches, starts as handleTaskMove with origin workflow, step checks, the move lock, and project-delete cleanup."
tags: [workflows, engine, scheduling]
sources:
  - resource: src/main/workflows/
  - resource: src/shared/workflow-route.ts
  - resource: src/shared/workflow-lock.ts
  - resource: src/shared/workflow-refusals.ts
---
# Workflow engine

A workflow is a set of linked tasks that run through their boards on their own (#732). It lives in
its home project's database with its links (`workflows`, `task_links`); its tasks live on their own
boards. A task's route (the columns it visits) is one pure shared module,
`src/shared/workflow-route.ts`, and so is who may move a workflow task,
`src/shared/workflow-lock.ts`, which main and the board both ask. Every refusal sentence is in
`src/shared/workflow-refusals.ts`, so main's error and the view's disabled tooltip read the same.

```
src/main/workflows/
  engine/
    workflow-engine-core.ts  # pure: what is ready, start order up to free slots, completion, links to drop, loops
  workflow-engine-host.ts    # main: wake-ups, debounce, read every running workflow, carry out the plan
  workflow-board-announce.ts # the quiet board reload after a workflow writes a board's tasks or links
  workflow-project-probe.ts  # what an unopened project holds that the engine reads, on a throwaway connection with no migrations
  workflow-lock-check.ts     # reads the databases and config the lock predicate needs
  workflow-step.ts           # a workflow task's own step at a turn end (the Automation agent judges it)
  workflow-step-condition.ts # the step's built-in condition, told the route (the last column asks only "waiting on you?")
  workflow-service.ts        # create, save the plan, start, pause, resume, link, route, remove, delete
  workflow-limits.ts         # MAX_WORKFLOW_TASKS, imported by the service and the MCP save tool's schema
  workflow-view-service.ts   # the view's read model (detail, summaries) and planned-workflow edits by key
  workflow-changed.ts        # the coalesced workflow:changed push and the onWorkflowChanged listener
  workflow-complete.ts       # the workflow:completed push, and the phone's workflow-complete push
  workflow-prompt-facts.ts   # what {{workflow_xml}} tells a workflow task's agent
  workflow-tasks.ts          # every created task of a workflow, across projects (a plain read), and
                             #   linkEndState: whether a link's missing end is gone or still holds
  workflow-home.ts           # the workflow a task is in, read in its home, never creating a gone home's database
  workflow-project-delete.ts # what a project delete does to the workflows it is part of
  workflow-agent.ts          # the workflow's own agent: open, resume, pause, end, start over on a lost resume,
                             #   read access to other projects, its spend captured for Stats
  workflow-agent-record.ts   # a SessionRecord built from the workflow row, so transcript readers reach its conversation
  workflow-agent-prompt.ts   # its first message: {{columns}}, {{brief_xml}} and the project's facts, and the
                             #   continue-from-the-saved-plan message for a start with no conversation to resume (a lost
                             #   one, or a plan no agent has seen; `WorkflowAgentContinueReason` names which)
  workflow-format.ts         # a workflow's plan as text (formatWorkflow), for the MCP tools and the continue message
  workflow-agent-effort.ts   # the effort it started at, for its Stats rows when the status line reports none
  workflow-runtime.ts        # the IPC context the operations act through
  workflow-wake.ts           # wake the engine from a write that does not wake it itself (a task or link delete, a project delete, a workflow started, resumed or edited)
```

- **The workflow agent** that plans a workflow is a transient session with its own MCP scope; see
  [Workflow agent](workflow-agent.md).

- **A stored project id can outlive its project.** A task's home (`workflow_project_id`), a link's
  far end and a planned task's board are ids in another record, and `getProjectDb` on main creates
  a database for any id it is given. Those reads go through `getExistingProjectDb`, which never
  creates a file and reads a gone project as having nothing. A project delete first runs
  `detachProjectFromWorkflows`, which does to its workflows what deleting each of its tasks would.
  A workflow homed in it goes, and that workflow's tasks on other boards become ordinary tasks.
  Links in other homes that name its tasks go. A running or paused workflow homed elsewhere that
  is left with no task is deleted, but only when every board could be read. A finished one stays.
  Start refuses a plan with a task on a board that is
  no longer registered. A membership whose workflow is gone (a deleted workflow's Done tasks keep
  theirs) is no membership to a check that protects a workflow (`isInWorkflow`): such a task can
  be demoted to the Backlog, moved to another project, or join another workflow, and its Workflow
  panel says the workflow no longer exists. A home that cannot be read still counts, and the panel
  says "The workflow this task is in could not be loaded." unless it already holds the workflow. A
  gone home's summaries and supersessions read as empty, not as an error.

- **The engine never polls.** The board bus (every move announces there), a freed agent slot
  (`session-removed`, `exit`), task deletes, and workflow writes wake it; a burst coalesces into
  one pass after 150 ms. Its only other timers are one-shot retries on a backoff: of a start that
  failed, and of a board it could not read (below). A pass with nothing running costs one indexed query per open project, and
  each is timed (`WorkflowEngineHost.stats()`, reported by the dev-only `kangentic_devtools_event_loop_lag`
  as `workflowEngine`). While a workflow is running or paused, a pass also asks each open board which workflows it
  holds tasks of (`TaskRepository.workflowIdsOnBoard`) and reads a workflow's tasks only on the
  boards that answer with its id. Both per-board reads keep their statement per connection. Before,
  every open board ran `listByWorkflow` for every running workflow, compiling it each time and
  grouping the whole attachments table. Measured (2026-10-12, the same rig as below, one running
  workflow on two boards, 40 passes): the median pass went from 6.45 to 1.8 ms with 50 boards
  open and from 7.54 to 2.1 ms with 69. With only its two boards open it is 0.9 ms, and each
  further open board adds about 0.02 ms. The core imports no Electron, IPC, database, analytics or Sentry and
  schedules no timer (`tests/unit/workflow-engine-boundary.test.ts`), so it can move to a utility
  process as a transport change.
- **The engine reads only open databases, and opens only what a workflow touches.** A registered
  project whose database main has not opened is looked at once, one per event-loop turn (again on
  each pass while the look fails, see the retry below), through
  `probeWorkflowProject` (`src/main/workflows/workflow-project-probe.ts`): a throwaway connection
  (`peekProjectDb`), no migrations, two indexed reads. It is opened only when it homes a running or
  paused workflow, or holds a task of one. After that, "open" stays complete with nothing stored:
  every write that brings a board into a workflow (a start, an added task, a resume) goes through
  `getProjectDb` on main, which opens it, and main closes a database only when its project is
  deleted. A second instance sharing the config dir can write a board unseen, until activation
  opens every registered board a few seconds after launch. A pass that cannot read a registered board completes no workflow, since that board may
  hold its unfinished tasks, and starts no task that waits on a task there. Only a SQLite failure
  makes a board unread: a lock, or a corrupt or half-migrated file. Any other error is a bug, and it
  ends the pass. The engine logs an unread board once a launch and shows the user nothing. While any
  registered board stays unread it wakes itself on a backoff (5 s, 30 s, 1 m, 2 m, then every 5 m),
  one timer at a time, because nothing else would. Activation opening the board, a lock clearing,
  or a repaired file announces nothing, and a finished workflow used to stay running until some unrelated board change. The first pass that
  reads every registered board, including after the broken project is removed, stops the retries.
  The timer is keyed on any unread board, not only on a running workflow the pass could see, since
  the board that would not read may home one. A board that stays broken costs one pass every 5
  minutes. `tests/unit/workflow-engine-boot-probe.test.ts` pins all of it against real files.

  Measured (2026-10-12, Windows, a vitest rig on copies of the 19 project databases registered on a
  developer's machine, the largest 2.3 GB, plus one registered project with no file; and 50
  synthetic boards of 200 tasks, one homing a running workflow with a task on a second board). The
  first pass used to open and migrate every database in one synchronous block: 122 to 128 ms on the
  real set and 242 to 286 ms on the synthetic one, with every handle kept and an empty database
  created for the missing file. Now the longest main-thread block in the boot pass is at the
  Windows timer floor (about 16 ms) on both. No real database is opened, since none homes a running
  workflow, and the synthetic set opens 2 of 51. The missing file stays missing. Per database
  (medians), a look costs 1.4 to 1.9 ms against 3.4 to 4.2 ms for `getProjectDb`, whose
  migrations alone are about 1.9 ms. Opening and closing alone is 0.2 ms; the rest of a look is
  its first read, which loads the schema. The probe's connection is
  read-write but only reads, because closing a read-only one left a `-wal` and a `-shm` behind on
  every database; read-write left none.

  This moves work out of the boot window rather than removing it. `activateAllProjects`, 5 s
  later, still opens and migrates every registered project whose folder or database file exists,
  on purpose: the retrieval worker opens databases with migrations off and relies on it. A project
  whose folder exists is also recovered, and gets a database if it has none, as on any open. One
  whose folder is gone is only migrated, and never given a file.
  Making activation lazy as well was weighed and not built. A database probe cannot decide most of
  recovery (the leftover-process sweep runs on almost every board, and resume and auto-spawn fold
  in board profiles and global config). Deferring it is visible: agents running at quit stay
  stopped and the phone reads a paused task as not resumable until the board is opened. And the
  worker's fan-outs (usage, the Knowledge Graph, index rebuilds) and search-all reopen nearly every
  project anyway, so they would need gating on a schema version the migrations do not have. The
  saving would be at most those projects' opens, about 4 ms each on the real set.

  Measured (2026-10-04, a dev preview on Windows, the mock CLI): a 20-task workflow (four roots,
  then waves of 8, 6 and 2 joined by 26 links, each task routed through Executing) ran from Start to
  complete in 34 s on 8 agent slots. Over 142 evaluations the p95 was 1.1 ms and the worst 1.5 ms,
  inside the 2 ms budget. The main thread did stall (19 stalls over 75 ms, the worst 152 ms), and
  every one was a synchronous git spawn through simple-git, about 25 per task lifecycle (worktree
  creation and removal, the diff reads). Eight ordinary tasks moved by hand made the same 25 per
  task with no stall, because their lifecycles did not overlap: the workflow adds no git work, it
  runs up to 8 lifecycles at once. So the fix went into the git layer, not into workflows. The
  lifecycle's git calls now start in the pty host: `gitAt` (`src/main/git/git-client.ts`) keeps
  simple-git's method shapes, success rule and error text over `execFileAsync`, and
  `spawnWithAbort` hands a git binary to `spawnOffMainCli` and keeps its timeout and abort. A
  suspend fires two churn captures for the same stopped agent (the move's and the exit handler's),
  and while they overlap they share one read. `tests/unit/git-lifecycle-off-main.test.ts` runs one
  lifecycle (start, a respawning move, Done, two PR resolves) against a real repository and spies
  on every spawn: 49 git processes with 45 on main before, 37 with none on main after. The 12
  saved are the share at its best case, both captures fired together; at a quiet Done the exit
  handler's read can settle before the Done branch asks, and then both run. The Changes
  panel's diff and file reads moved too, since they share `DiffService` with the churn capture. So
  did three calls that run repository hooks, filters or merge drivers, for a different reason:
  `gitAt`'s env drops Crashpad's pipe name (see "PTY children and Crashpad's handler" in
  `docs/platforms/windows.md`). They are Update from base's merge, the carry of uncommitted changes
  into a new worktree, and the Command Terminal's cold-start checkout and merge. Still on main
  through simple-git, and outside a workflow's lifecycle: the Changes panel's ahead and behind count
  and its watcher, blame, file history, the commit graph, the worktree list, a task's branch switch
  config write, and the pending-changes probe of a Done drop.
- **A start** is `handleTaskMove` with origin `workflow`, into the first column of the task's route,
  after `forgetRecentFetches` so the worktree is cut from the blockers' merged code. Starts go in To
  Do order, up to `SessionManager.getFreeAgentSlots()`.
- **A step** finishes at a turn end the Automation agent judges done (after the column's own
  turn-end rows), at plan approval, or when the task's own agent moves it. The answer is recorded in
  `automation_runs` as a `workflow_step` row.
- **The lock** (`workflowMoveRefusal`) is asked by `handleTaskMove` before it aborts anything and
  again inside its Phase 1 lock, and by `kangentic_move_task` before it fires. The caller's task
  comes from the MCP request's caller segment (`CommandContext.callerTaskId`).
- **MCP:** thirteen workflow tools in their own category (`workflow-tools.ts`,
  `workflow-commands.ts`). Only list, get, pause and resume reach the phone's board-tool path.
