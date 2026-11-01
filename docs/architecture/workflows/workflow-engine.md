---
type: Reference
title: Workflow engine
description: "How the workflow engine runs linked tasks: the pure core and its main-process host, wake-ups coalesced to 150 ms with no polling, the boot probe that opens only boards a workflow touches, starts as handleTaskMove with origin workflow, step checks and the recovery of a step that did not finish, the memory gate its nudges wait in, the memory resume of paused tasks, the hung-turn check, the move lock, one task's own hold, and project-delete cleanup."
tags: [workflows, engine, scheduling]
sources:
  - resource: src/main/workflows/
  - resource: src/shared/workflow-route.ts
  - resource: src/shared/workflow-lock.ts
  - resource: src/shared/workflow-refusals.ts
  - resource: src/shared/workflow-needs-owner.ts
---
# Workflow engine

A workflow is a set of linked tasks that run through their boards on their own (#732). It lives in
its home project's database with its links (`workflows`, `task_links`); its tasks live on their own
boards. A task's route (the columns it visits) is one pure shared module,
`src/shared/workflow-route.ts`, and so is who may move a workflow task,
`src/shared/workflow-lock.ts`, which main and the board both ask. Every refusal sentence is in
`src/shared/workflow-refusals.ts`. Main throws `WORKFLOW_REFUSALS`, in English. The view resolves the
paired `WORKFLOW_REFUSAL_MESSAGES` descriptors with `translateText`, so the two read the same in
English and differ in a translated locale.

```
src/main/workflows/
  engine/
    workflow-engine-core.ts  # pure: what is ready, start order up to free slots, completion, links to drop, loops
  workflow-engine-host.ts    # main: wake-ups, debounce, read every running workflow, carry out the plan
  workflow-board-announce.ts # the quiet board reload after a workflow writes a board's tasks or links
  workflow-project-probe.ts  # what an unopened project holds that the engine reads, on a throwaway connection with no migrations
  workflow-lock-check.ts     # reads the databases and config the lock predicate needs
  workflow-step.ts           # a workflow task's own step at a turn end (the Automation agent judges it), and its verdict
  workflow-step-condition.ts # the step's built-in condition, told the route (the last column asks only "waiting on you?"),
                             #   the second ask of what a stalled agent is stuck on, and the column's exit rows' verdict
  workflow-recovery.ts       # a task whose step did not finish: re-judge, nudge, or one notice, on a schedule that ends
  workflow-recovery-state.ts # the tasks under recovery, with no imports, for the move path, the idle sweep, the
                             #   low-memory pause and Pause
  workflow-memory-gate.ts    # one queue for nudges and memory resumes: none while memory reads low, one at a time, paced
  workflow-memory-resume.ts  # a running workflow's memory-paused tasks back one at a time once memory recovers
  workflow-hang-check.ts     # a turn shown working that has written nothing past its agent's limit: interrupt, or tell
  workflow-task-hold.ts      # one task's own hold (its automations switch): what putting it on and taking it off does
  workflow-service.ts        # create, save the plan, start, pause, resume, link, route, remove, delete
  workflow-never-started.ts  # a task in To Do with no session, worktree or move out, which a delete may take along
  workflow-limits.ts         # MAX_WORKFLOW_TASKS, imported by the service and the MCP save tool's schema
  workflow-view-service.ts   # the view's read model (detail, summaries) and planned-workflow edits by key
  workflow-changed.ts        # the coalesced workflow:changed push and the onWorkflowChanged listener
  workflow-complete.ts       # the workflow:completed push, and the phone's workflow-complete push
  workflow-prompt-facts.ts   # what {{workflow_xml}} tells a workflow task's agent
  workflow-tasks.ts          # every created task of a workflow, across projects (a plain read), and
                             #   linkEndState: whether a link's missing end is gone or still holds
  workflow-home.ts           # the workflow a task is in, read in its home, never creating a gone home's database,
                             #   and whether it is paused (isTaskWorkflowPaused) for the paths that start nothing then
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
  workflow-catch-up.ts       # Resume's ask that the turn-end runner judge a live agent's last reply, as a resume does
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

  This moves work out of the boot window rather than removing it. `activateAllProjects`, once per
  process and 5 s after the first renderer load, still opens and migrates every registered project
  whose folder or database file exists, on purpose: the retrieval worker opens databases with
  migrations off and relies on it. A project
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
- **A step** finishes at a turn end the Automation agent judges done and the column's own exit rows
  accept (after the column's own turn-end rows; see below), at plan approval, or when the task's own
  agent moves it. The answer is recorded in
  `automation_runs` as a `workflow_step` row. `runWorkflowStep` returns one verdict: `done`,
  `move-failed`, `waiting` (only the owner can settle it), `working` (work of the agent's own is
  still open), `stopped` (a stall to nudge), `check-failed`, or `human-gate` (no Automation agent).
  A check that could not run is recorded too, with `condition_met` NULL, so it never counts as
  having judged the reply. A failed move is reported, not thrown.
  - **Only the agent's own word stops a task** (owner's decision, 2026-10-31). A reply whose last
    line is `Needs owner: <question>` is `waiting`, matched in code before any check runs
    (`needsOwnerQuestion`, `src/shared/workflow-needs-owner.ts`). It costs no check, and it works
    in a human gate too. Case and markdown marks are forgiven, and the label ends at a colon or a
    spaced dash, so a last sentence that only starts with the words is not the line. The
    `<workflow>` block and every nudge tell the agent to end on that line only for a change from the
    plan, something the owner must weigh in on, or a decision between options, and to act on
    anything else. No other wording in a reply stops a task.
  - **Still working comes from the hook events, never from the reply.** A step judged not done
    whose agent still holds a background shell, or a subagent running past its turn end
    (`SessionManager.getOpenWork`, the activity engine's open-work ledger), is `working`, with no
    second call. Read from the reply, one gate was still running at 04:47 and not done at 07:33,
    with nothing changed but the sentence.
  - **Anything else not done is `stopped`.** A second ask names what the reply says the agent is
    stuck on (`workflowBlockerConditions`), so the nudge can aim at it: `resource` (a run was
    stopped or failed because the machine was low on memory or too busy) and `main-fails-too`
    (the same failures happen on the task's base branch, which the row names). Both rows are one
    call. A blocker ask that could not run still gives `stopped`, with no blockers, so the general
    nudge goes out. A turn with no reply text is a plain stall, with no second call. This ask
    replaced the one that chose between a wait on the user and work still running.
    `main-fails-too` is there because one agent, nudged that its gate was not green, spent two
    hours fixing a race the base branch fixed on its own.
  - **A column's own exit rows outrank the check's yes** (`stepExitVerdict`). Exit rows are the
    column's enabled turn-end rows whose type moves the task (the manifest's `endsGroup`) behind a
    Text match, each with its target resolved by `resolveMoveTarget`, as the row's own move resolves
    it. A row into Done or a later column is forward; any other row sends the task back. A yes on a
    reply whose final line no forward row matches, in a column that has one, is not done. So is a
    yes on a reply only a send-back row matches. Either goes on to the second ask like any no, with
    a reason that quotes the line and never names the line to type, since a nudged reviewer told
    which line moves it on could type just that. A column with no exit rows, or only send-back
    rows and no match, is judged by the check alone. Task 916 is why: its review ended "No changes
    to review.", neither Code Review row matched, and the check moved it to Testing unreviewed.
  - Forward is by position, not by equality with the route's next column, so a route that skips
    the column a row names still accepts that row's line, and the step moves the task to the
    route's own next column. Frequency is not read: Code Review's "On to Testing" runs once, so a
    second pass through Code Review relies on the step to accept "Verdict: Ready" after the row is
    spent, and a spent "Back for revisions" must not let a fourth "Verdict: Blocked" go forward.
    The rule holds wherever the step runs, including the resume catch-up and recovery, which run no
    rows.
- **Recovery** (`workflow-recovery.ts`) acts on a verdict that does not move the task. It holds the
  rule that a running workflow either moves on or tells the user why it cannot.
  - The schedule is 5, 15, 30 and 60 minutes. Each attempt runs as a pass of the turn-end runner's
    own (`recovery`), judges the session's current turn (reusing a verdict it already has for that
    turn), and then moves, nudges, or notifies.
  - A reply written before the task entered its column is never judged there, as the resume
    catch-up never judges one (`judgeCurrentTurn`). That reply belongs to the last column. Judged
    as this column's, a reply that read done moved a card a person dragged on past work it never
    did. The attempt reads it as a stall and nudges, with no paid check.
  - A nudge is one line typed into the terminal, only while nobody is there: no draft, no input
    typed into it in the last 5 minutes (`getLastUserInputAt`, `PRESENCE_WINDOW_MS`), nothing on
    its way, the agent idle on the judged turn, and keys allowed (`automatedKeysRefusal`: no
    permission prompt pending and no tool call open). A terminal on screen is not a person: one
    left on screen held a task an hour overnight with nobody typing.
  - The nudge (`nudgeMessage`) is aimed at what the agent is stuck on, each blocker with its own
    instruction. Memory is back, with the GB free, so run what was stopped again, one run at a
    time. The base branch fails the same tests: the agent's own claim, so the nudge has it run the
    failing tests on a separate clean checkout of the base (never by switching its own branch),
    record the ones that fail there too, and fix any that pass, since a wrong claim told "not this
    step's to fix" would leave a regression the step made. Kangentic restarted, so start the
    background commands again. A sibling task's PR merged into the base branch since the step
    began: said as a fact for the agent to weigh, not an order to merge, since the sibling may have
    nothing to do with the step. A fact is not an instruction, so a nudge that names only a
    sibling, or none of these, quotes the check's reason, cut at a word boundary, and says to carry
    on. Every nudge says to go ahead with the step's own work without asking, and
    ends with the `Needs owner:` line. On the board measured, every message a person typed into a
    stopped workflow task said to keep going.
  - A sibling is named only when its PR merged, it was archived after the visit began (or after
    the last nudge that named siblings), and it has the same base branch. Reaching Done is not
    enough: some routes end at Done with no PR, and some siblings target another base.
  - `working` gets one 60-minute wait first. On the board measured, 300 turn ends were woken by
    the agent's own background work, none more than 30 minutes later.
  - **One at a time, and never into low memory.** Every nudge waits its turn in the workflow's
    memory gate (`workflow-memory-gate.ts`), one first-in, first-out queue it shares with memory
    resumes (below). Nothing goes while memory reads low, on the low-memory pause's own latch
    (`evaluateMemoryRelief`). A reading older than 3 minutes is not low, so a sampler that stopped
    holds nothing. One item goes at a time: the next waits until the last one's session goes
    thinking, the last one typed nothing after all, or 3 minutes pass. At most one goes every 60 s
    (`PACE_MS`), about one sampler tick, so the next reads memory with the last one's load on it.
    The pacing holds even while memory reads fine. A hold for memory spends no attempt, and the run
    log says so once per low spell. A task has one place in the queue (`workflowTaskGateKey`),
    shared by its memory resume and its nudges, so the nudge a resume exists for continues the
    resume's place after the pace. A resume starts no turn of its own, so with places of their own
    the nudge waited out the full 3 minutes behind its own resume. A memory resume that no longer
    asks for its place (its task was resumed by hand, or moved) leaves the line at once
    (`withdraw`). Measured overnight: three nudges sent within four seconds started three gates at
    once, and all three failed on load. A nudge that said to rerun a gate Claude Code's memory
    reaper had stopped sent one back at 3.7 GB free, to be killed again.
  - **After Kangentic restarts an agent, at once.** A session Kangentic resumed after a quit, a
    crash or a pty host loss (`resumedBy: 'recovery'` on the `session-resumed` event) lost its
    background commands with the old process. Its recovery starts over, with a run-log row that
    says so, and its first attempt comes at once, with the restart line. Before, each mid-step
    task kept its pre-quit `working` verdict and waited an hour on a gate that no longer existed.
    A memory resume (`'memory'`) gets its first attempt at once too. The resumed session's first
    idle has usually armed the schedule's first step already, and the resume replaces that timer:
    kept, the nudge came five minutes after the agent was back (seen live).
  - The keys refusal holds the nudge a minute at a time. An idle agent whose tool call has had no
    end for 10 minutes (`OPEN_CALL_NOTICE_MS`) is most likely at a prompt the engine lost, so
    recovery stops and the owner gets the waiting notice ("it may be waiting on a permission
    prompt for <tool>"). A nudge whose keys reached a permission prompt
    (`KeysReachedPermissionPromptError`) is recorded as failed, since its keys may have answered
    the prompt, and spends nothing.
  - Only a nudge whose turn ran counts toward the 4. A check that failed, or a nudged turn that
    failed, spends nothing, and after the schedule an outage is re-judged hourly for up to a day.
  - The stall notice goes out once a recovery, on desktop (`DesktopNotifier.notifyWorkflowTask`,
    past the focus gate), on the phone as `input-required`, and as the `workflow:stalled` toast.
    Its `workflow_stalled` row is the latch and the card's mark, so a restart keeps both.
  - After a stall, a turn recovery did not start (the user typed, a column message) that stops
    again starts a new recovery (`workflow_recovery_start`), with its own nudges, its own notice
    and its own 24 hours. A nudge's own turn carries its recovery on (`lastTurnFromNudge`; after
    a restart, a turn is the user's only when no nudge ran since the stall).
  - In an outage the task stays under recovery after the notice, so the idle sweep does not pause
    it for up to the day the hourly re-checks run. That keeps its agent alive overnight (about
    1.15 GB of commit on Windows), so the service coming back can move it on; the low-memory
    pause still applies.
  - A `waiting` verdict is noticed at once and ends the recovery. A running workflow task's plain
    idle raises neither the desktop idle notice nor the phone's `turn-complete`.
  - It is armed by a turn end's verdict, by a resume whose reply was already judged (a restart; the
    engine's own boot pass runs before any session resumes, so it cannot see who is idle), by a
    commit to idle with nothing armed (a turn that failed with no Stop), and by sending a nudge.
  - It is stopped by a move (`supersedeTurnEndWork`), the workflow's Pause, pausing the task's own
    automations (the same supersede), removing the task or deleting the workflow, and a low-memory
    pause. That pause notifies nobody: it writes a recovery start ("Paused to free memory"), so
    the agent that comes back gets a recovery of its own. The idle sweep leaves a task under
    recovery alone (`isUnderWorkflowRecovery`). The low-memory pause leaves alone an agent with
    open background work, and one in a `working` wait under 60 minutes old (`isInWorkingWait`):
    five of seven pauses overnight hit agents waiting on their own background gate, which left the
    gate's processes running and its results unread for 45 to 110 minutes.
  - A start that keeps failing for 30 minutes sends the same stall notice through
    `announceWorkflowStall`, and its retries go on.
- **Memory resume** (`workflow-memory-resume.ts`). #873 holds a low-memory pause until the user
  resumes it, and that still holds outside a workflow. A running workflow's task comes back by
  itself (owner's decision, 2026-10-31): overnight, two workflow tasks whose agents really were
  idle were paused at 01:39 and 04:05 and sat until morning with memory long recovered.
  - The pause records `suspended_by = 'low_memory'`, its own source, so a restart still knows which
    tasks those are (`SessionRepository.listMemoryPausedTasks`).
  - Each memory sampler tick, while memory does not read low, the task paused longest comes back,
    if it is in a running workflow whose step applies (not held), in a working column (not To Do or
    Done), and not waiting on the owner. One at a time, through the memory gate, and only into a
    free agent slot. A task a person is resuming at that moment is skipped (`isResumeInFlight`):
    the Resume path cancels a resume already under way, and the person's must win.
  - It comes back through the Resume button's own path (`resumeTaskSession`) with
    `resumedBy: 'memory'`, which reaches the spawn on both of its branches (a plain resume, and a
    column entered while paused through `spawnAgent`). The resume's catch-up hands the turn to
    recovery, whose first attempt comes at once.
  - A task paused again within 30 minutes of an auto-resume waits 30 minutes from that pause,
    doubled for each further auto-resume in the last day. After 3 in a day it stays paused for the
    user, with one stall notice, until the oldest of those resumes is a day old. Only a resume that
    ran counts: one that failed waits 30 minutes, doubled for each failure in a row, and one that
    found the agent already live counts nothing. Each resume reloads the conversation: one
    overnight resume read 73M tokens before its first tool call. The counts live in main-process
    memory, so a restart forgets them.
- **A hung turn** (`workflow-hang-check.ts`) ends no turn, so recovery never sees it. Once a minute,
  main looks at each running workflow task whose agent shows working on a turn still in progress
  (a tool, a subagent or the turn itself; never a turn a background shell holds, and never a
  permission prompt or a question). When the agent's history and its subagents' have had no write
  for the adapter's `hungTurn.quietLimitMs`, it writes the CLI's own interrupt, once, and records a
  `workflow_interrupt` row. It tells the activity engine the way a user's Ctrl+C does
  (`signalUserInterrupt`), since an interrupt between tool calls fires no hook and the turn would
  stay shown working. It starts the task's recovery over (`startWorkflowRecoveryOver`), so the
  idle that follows gets the schedule's first step even when the visit's recovery was spent.
  An interrupt that lands writes to the history (Claude records `[Request interrupted by user]`).
  When nothing has been written two minutes later, whatever the engine shows, the stall notice
  goes out and recovery starts over again past it, for an agent that comes back later. It holds
  while text is typed into the prompt or a message is on its way, and never writes to a session
  its task has moved off. Only Claude declares `hungTurn` so far.
  - What to count on is the notice, about 22 minutes after the last write. If the pty host itself
    stopped, the interrupt goes through that host and cannot land.
  - A user who raised Claude Code's foreground command cap past 20 minutes can have a long
    command interrupted.
  - Measured on 437 turns of the board's workflow tasks: no healthy turn went more than 10.0
    minutes without a write, Claude Code's own cap on a foreground command. Three turns froze
    within ten seconds of each other and sat 114 minutes, shown working, until a restart. Claude
    declares 20 minutes and Esc.
  - It reads the history from main. The activity engine runs in the pty host, and during that
    freeze none of the engine's own watchdogs fired, which looks like the host itself stopping.
- **The lock** (`workflowMoveRefusal`) is asked by `handleTaskMove` before it aborts anything and
  again inside its Phase 1 lock, and by `kangentic_move_task` before it fires. The caller's task
  comes from the MCP request's caller segment (`CommandContext.callerTaskId`). Every caller passes
  `taskHeld`; a held card in a running workflow moves by hand as a paused workflow's card does.
- **One task's own hold** is its automations switch (`tasks.automations_disabled`), asked only
  through `canTaskRunAutomations`, so a person can work one task by hand while the rest runs.
  - `workflowStepApplies` answers no for a held task, which stops the step check at a turn end
    (and its post-check re-read, so a hold set during the paid check moves nothing), the resume
    catch-up, `armWorkflowRecoveryOnIdle` and each recovery attempt. `isRunningWorkflowStepTask`
    answers no too, so the hang check leaves its turns alone and the plain idle notice and the
    phone's turn-complete push come back. `announceWorkflowStall` sends nothing for it and
    `stallReader` shows no mark.
  - The core's `readyTasks` skips a held task (`CoreTask.held`), and `startTask` re-checks it, so
    a held task in To Do stays queued and what waits for it keeps waiting.
  - The lock lets a person move its card to any column but To Do (`taskHeld`), and the board's
    reads agree: `humanGateExit` names no gate for it, `isLockedOnBoard` and `sendAwayRefusal`
    read the hold, and the phone's `lock_reason` is null. Backlog and Archive stay refused.
  - The hold never suspends an agent by itself. The workflow's own Pause does stop a held task's
    agent, and Resume brings it back still held, with no new agent for a held task that has none
    (decided 2026-10-27, task #925).
  - A plan approved by hand still moves it on: the `plan-exit` auto-move is the person's act, and
    Automatic approval is held as Manual (`readPlanApprovalDecision`).
  - `applyAutomationsHoldChange` (`workflow-task-hold.ts`) runs after the two writes that flip it
    (the task update IPC and `handleUpdateTask`, which the phone shares). Putting it on calls
    `supersedeTurnEndWork`. Taking it off, in a working column, writes a recovery start (so a task
    held while stalled comes back with a fresh schedule rather than a spent one) and, with a live
    agent that is idle, asks for the resume catch-up (`requestWorkflowCatchUp`, shared with the
    workflow's Resume), which judges a reply of this visit. Point forward only: a reply from before
    a hand move and the enter rows that move skipped are left alone, and a paused agent stays
    paused.
- **Pause** (`pauseWorkflow`) writes the state, cancels recovery and stops each task's turn-end
  work (`supersedeTurnEndWork`), so a row a running agent's last turn set off moves nothing. Then it
  calls `pauseTaskSession` for every task at once, a held task's included, with or without a
  session pointer. The pause's own reconcile re-links a live agent whose pointer was lost, and
  cancels a resume or an `autoSpawnForTask` still in flight. A paused workflow starts nothing by
  itself:
  - The lock refuses the `workflow` origin while paused. `handleTaskMove` asks it under the task
    lock, so an engine start or a step move that raced the Pause does not move the card. The
    engine host takes that refusal as the Pause working, not as a failed start: no backoff, toast
    or stall notice, and Resume's wake starts the task. A step move refused that way
    records no failed move and arms no recovery (`runWorkflowStep`), so the reply is judged again
    after Resume.
  - `handleTaskMove` notes in Phase 1 whether a move no person made (`workflow`, `automation`,
    `auto-move`, or `agent`, which the lock admits under a running workflow only from the task's
    own agent) passed the lock under a running workflow. Its Phase 3 skips the spawn when that
    workflow paused during the unlocked Phase 2. The card stays where it landed, and Resume brings
    its agent back there.
  - The startup auto-spawn pass skips a paused workflow's tasks (`isTaskWorkflowPaused`), except in
    a pty-host-loss pass (`lostScope`), which brings back agents a person had resumed.

  Hands, the `automation` and `auto-move` origins and the task's own agent still pass the lock. A
  card a person works during a pause is an ordinary card and may run on through its board (decided
  2026-10-27, task #925). A card the Pause stopped stays paused through any move (decided
  2026-10-28, task #929). `handleTaskMove`'s Priority 4 finds the held pause
  (`isHeldPause(getLatestForTask)`) and, the way Priority 2.5 does, arms the destination's enter
  rows with `agentPaused` and spawns nothing. The rows that need no agent run, and the runner
  records each row that needs the agent as skipped with "The agent is paused. This row runs if the
  agent is resumed in this column." `spawnAgent` still refuses a held pause for every other caller.
  A recovery move out of Done skips that branch: the move restores the worktree Done removed and
  `spawnAgent` refuses the pause, and the later Resume sends the agent nothing.
- **Resume** (`resumeWorkflow`) decides each task in a working column under its lock. A live agent
  is left running, and its last reply goes to the turn-end catch-up (`requestWorkflowCatchUp`,
  which the runner registers with `setWorkflowCatchUp`): a person may have worked it to the end of
  its column during the pause, and an idle agent ends no turn that would be judged. A paused one (a
  `suspended` registry row or record) comes back through
  `resumeTaskSession`, in any column, and is awaited (all tasks at once). When the task entered its
  column after that record was suspended (`currentVisit(...).at` later than `suspended_at`) and the
  column starts an agent, `resumeTaskSession` goes through `spawnAgent` with `resumesEntry`: the
  column's own strategy (fresh in an always-new column, so #919's resume in Code Review would have
  opened a new conversation) and only its enter rows that need the agent. A task with none, its
  automations on and its column's profile-folded `auto_spawn` on, gets `autoSpawnForTask` without
  `explicitStart`, so a held pause still decides, and the column's enter list runs. That start is
  counted on acceptance and not awaited: an enter list can run a script for minutes, and the
  phone's Resume answers within 10 s. Then the engine wakes, and a task finished during the pause
  lets its dependents start.
- **The record.** Pause and Resume each log one line naming who asked: the Workflows view, the phone
  (`CommandContext.via`), a task's agent, or an MCP client. `[WORKFLOW] Paused "<title>" from the
  phone: 3 agents paused, 2 tasks had no live agent, 1 failed (#917)`. Their report
  (`WorkflowPauseReport`, `WorkflowResumeReport`) is the IPC answer, where a Pause that could not
  stop an agent raises a toast naming its task, the MCP reply's counts, and the phone's board-tool
  result.
- **MCP:** thirteen workflow tools in their own category (`workflow-tools.ts`,
  `workflow-commands.ts`). Only list, get, pause and resume reach the phone's board-tool path.
