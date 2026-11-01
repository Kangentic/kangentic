---
type: Reference
title: Transition engine
description: The task-move priority ladder (To Do, Done, auto_spawn off, live session, no session), the four live-session cases, the six automation adapters and their fields, isolated bounded recorded runs, the Template Variables table, AbortSignal cancellation, plan_exit_target_id and cross-agent handoff.
tags: [transition-engine, automations, template-variables, handoff]
sources:
  - resource: src/main/transition-engine/transition-engine.ts
  - resource: src/main/transition-engine/agent-resolver.ts
  - resource: src/main/automations/automation-runner.ts
  - resource: src/main/automations/automation-registry.ts
  - resource: src/main/automations/column-message.ts
  - resource: src/main/automations/adapters/
  - resource: src/shared/automation-manifest.ts
    title: AUTOMATION_MANIFEST
  - resource: src/shared/automation-describe.ts
  - resource: src/shared/task-template-vars.ts
    title: TASK_TEMPLATE_VARS catalog
  - resource: src/main/agent/shared/task-template-resolvers.ts
  - resource: src/main/ipc/handlers/auto-spawn-reconcile.ts
  - resource: src/main/ipc/helpers/plan-exit-target.ts
  - resource: src/shared/template-escape.ts
  - resource: src/main/transition-engine/resume-prompt-delivery.ts
---
# Transition engine

`src/main/transition-engine/transition-engine.ts`

The transition engine runs a column's automations when tasks move between swimlanes. It handles the logic that makes Kanban columns "active" -- spawning agents, sending messages, running scripts, calling webhooks, and raising notifications.

Each column owns ONE ordered list, split into three groups: On task enter, On agent turn end and On task exit. An automation belongs to exactly one column: there are no `from -> to` pairs and no shared, named actions. Every type is an adapter under `src/main/automations/adapters/`, declared once in `AUTOMATION_MANIFEST` (`src/shared/automation-manifest.ts`), and the engine dispatches through `automationRegistry`. Users edit the lists in the Column Manager; the file format is [Configuration cascade](../../settings/cascade.md#column-automations) and the tables are [Board tables](../../database/board-tables.md#column_automations-table).

## Priority Rules on Task Move

When a task moves from one column to another, the IPC handler (`task:move`) checks these conditions in order. The first match wins:

| Priority | Condition | Action |
|----------|-----------|--------|
| 1 | Target is **To Do** (role=`todo`) | Drop the PR link of a task that did its own work as the move commits (`forgetPRLinkOnTodoReset`, see [PR linking](../../integrations/pull-requests/pr-linking.md#where-pr-state-is-persisted)), then kill session, reap what the task left running, remove worktree (and branch when `git.autoCleanup` is on) |
| 2 | Target is **Done** (role=`done`) | Suspend session (resumable), reap what the task left running, archive task |
| 2.5 | Target has `auto_spawn=false` (non-todo, non-done) | Suspend session |
| 3 | Task has **active session** | A model or effort change suspends and respawns with the destination's CLI flags. A column message alone is injected into the running session. A permission-only change, or none, keeps it alive. |
| 4 | Task has **no session** | Resume suspended session (with the column's message as the resume prompt, or typed in once the agent is ready where the resume cannot carry it) OR create worktree (if enabled) + run the destination's On enter group |

The SOURCE column's On exit group runs ahead of all five, in Phase 1. See [Triggers](triggers.md).

A move made by the task's own live session (through `kangentic_move_task`) that ends that session, at Priority 2, 2.5 or one of Priority 3's suspends, waits for the turn that made the move to end before it suspends. See [A call that ends the caller's own session](../sessions/suspend-and-cleanup.md#a-call-that-ends-the-callers-own-session).

"Active session" is decided against the registry, not the raw `task.session_id`. Phase 1 runs `reconcileTaskSessionRef` (`session-reconcile.ts`, the same self-heal `SESSION_RESUME`, `SESSION_RECONCILE`, `SESSION_SUSPEND`, `task:setRuntimeOverride`, and the auto_spawn-off suspend in `reconcileAutoSpawnChange` use) before the ladder: a pointer at a non-live registry row (an agent that exited on its own, a `--resume` that could not read its transcript) is cleared so the move takes Priority 4 and resumes the record, and a live PTY the pointer lost is re-linked so the move takes Priority 3 instead of spawning a second agent. Before #682 the raw pointer decided, and a task whose CLI had ended by itself was "kept alive" on every move with nothing running.

### Priority 3: Active Session Handling

Priority 3 has four sub-cases, checked in order:

**a) Agent change (handoff):** If `resolveTargetAgent()` returns a different agent than the current session's agent, the session is suspended and the engine falls through to the `spawnAgent` path. The `agentOverride` parameter is set on the spawn request to prevent the new session from resuming the old agent's session. **Side effect:** per-task `model_override` and `effort_override` are cleared on handoff because override values are model-name-specific and don't carry across agents (Claude's `claude-sonnet-4-6` is meaningless to Codex). This clear is skipped when `task.agent_override` is set, since the user locked the agent at creation and the overrides remain valid for that agent. If the target column has `handoff_context` enabled, the new agent is pointed at the previous agent's own session history file. If disabled (the default), no history is packaged: the new agent gets only the task title/description, or resumes its own earlier conversation on this task when one is resumable. See [Cross-Agent Handoff](#cross-agent-handoff) below.

**b) Same agent + model or effort change:** If `prepareInjectionPlan` returns a `restartReason` (`'model'` or `'effort'`), the session is suspended and respawned so the destination's `--model` / `--effort` / `--permission-mode` land as launch flags. Nothing is typed into the PTY: a live `/model` left the agent paused after a Planning -> Executing handoff, and a mid-turn `/effort` writes no transcript entry, so it could not be confirmed on a plan-exit move, which always lands mid-turn. The respawn resumes the same agent session id and carries the column's message as its prompt, or types it in once the agent is ready where the resume cannot carry it (see [How the resume prompt arrives](../sessions/resume.md#how-the-resume-prompt-arrives)). A plan-exit auto-move passes a continuation prompt that names the destination column ("The session restarted to apply the <column> column's settings. Proceed with implementing the approved plan.") delivered as the resumed session's first message only when neither the destination column's message (its first enabled `send_message` enter automation) nor the task's own `auto_command` is set; either one takes the prompt slot instead. No continuation is sent when the move switches session track (into or out of an isolated column), lands in an `always_spawn_new` column, or changes agent: each of those lands in a conversation that never saw the plan. The progress label is `switching-model` for a model change and `applying-settings` for an effort-only one.

The delta is computed against what the session is *actually running at*, not the leaving column, so a column whose value the session already has restarts nothing. The two fields resolve that differently: **model** uses the session record's `applied_model`, while **effort** prefers the level the agent itself reports (`task.effort_override ?? <agent-reported effort> ?? record.applied_effort`), because `applied_effort` records only what Kangentic last asked for and an `/effort` typed straight into the terminal never reaches it. A level the model silently downgraded counts as applied: when the target equals `applied_effort` and the reported level has not moved since the session's first report, nothing restarts. Model deliberately stays record-only - telemetry reports canonical ids while the configured values are flag strings, so comparing them would read a false change and restart the PTY on every move. Only a concrete target restarts: entering a "Default" column (null target) keeps the session, since `--resume <id>` preserves what it runs at. A per-task override wins on both sides, so a pinned field never restarts. See [Command Injection](command-injection.md) for the full precedence.

**c) Same agent + column message only:** If the plan carries the column's message and no `restartReason`, the message is scheduled into the running session via `TerminalSubmitScheduler.scheduleKeystrokes`. No suspend/resume cycle occurs. A column message that `shouldPaste` (more than one line or over 1,000 characters, and not a slash command) stays out of the plan and is pasted into the session instead, after the turn ends; the row still counts as delivered, so the On enter group does not send it again.

**d) Same agent, permission-only change or no change:** The session stays alive with no interruption. A permission-mode delta never restarts: in the canonical Planning -> Executing flow the user already approved the plan in the terminal and Claude left plan mode in-session, so the spawn-time permission mode recorded on the session is stale.

## The agent starts on demand

Nothing in a list starts the agent explicitly. An adapter declares what it `needs` (only `send_message` needs `'agent'`), and on enter the runner calls `startAgent()` once, right before the first row that needs it. If no row needed it, the caller's fallback spawn runs after the list as it always did.

On exit there is no `startAgent`: the task is leaving, so a row that needs an agent the task does not have is recorded `skipped` with the reason rather than starting one.

A column that cannot meet a need shows the row switched off with its switch disabled (Start an agent here is off), and the draft keeps the stored `enabled` so turning the setting back on restores it.

## Automation adapters

Six types, five of them offered for a new automation. Each declares its fields, its per-field escaping, its timeout and its retry policy in `AUTOMATION_MANIFEST`, which the renderer reads for the picker, the Edit automation dialog and the row sentence. A type may also declare the triggers it runs on (`triggers`, with `triggerUnavailableReason`) and that a row of it ends its group (`endsGroup`). A field may declare one trigger where it does nothing (`unavailableOn: { trigger, reason }`): the Edit automation dialog keeps it there, disabled, with the reason on each option, leaves its stored value alone, and the row earns no mark for it. Consumers read it through `automationFieldUnavailableReason`, never by the field's key. `tests/unit/automation-adapter-parity.test.ts` fails if the registry and the manifest disagree, and `tests/unit/automation-manifest-reserved-keys.test.ts` fails an `unavailableOn` on a field that cannot show it or on a trigger the type never runs on.

### `send_message` -- Send message to agent

Delivers an interpolated message to the task's agent. This is what the retired `Swimlane.auto_command` became: the migration moved every column's message into one of these.

| Field | Type | Description |
|-------|------|-------------|
| `message` | string | The text, with `{{placeholders}}`. Escaping is `none`, because it is prose going to an agent |
| `mode` | `'immediate'` \| `'deferred'` | Run immediately (interrupts the current turn) or wait for the current turn. Unavailable on `turn_end` (`unavailableOn`): the turn is already over, so it sends at once |

Needs the agent. No timeout of its own beyond the scheduler's 120s, and no retry: `TerminalSubmitScheduler` already has a confirmation verifier and a one-shot escalation ladder. Delivery goes through `context.deliverToAgent`, which applies the three rungs when this run started the agent and the plain scheduled keystroke otherwise. See [Command Injection](command-injection.md).

Keystrokes turn line breaks into spaces, so every path that hands a message to a live agent asks one question first (`shouldPaste`, `automations/turn-end/agent-message-delivery.ts`). A message with more than one line, or over 1,000 characters, is pasted with bracketed paste (`submitContent`) and keeps its line breaks. A one-line message, and any message that starts with `/`, stays keystrokes, the only way a slash command runs: `/code-review {{attachments}}` spans lines once the paths are filled in, and it is typed on one line so the command still runs. When a paste lands depends on the trigger:

- **On task exit:** awaited inside the exit budget, and handed the run's signal. `immediate` pastes at once; `deferred` waits for the agent's turn to end first.
- **On task enter, Run again, and the warm move's column message:** in the background, once the agent's turn has ended and the scheduler has no keystrokes left for the task, whatever the mode. A task's pastes run one at a time, in order, on every trigger, so two of them never write into the terminal at once. On a fresh spawn that is the end of the agent's first turn. A move to another column cancels a paste still waiting (`supersedeMessageDeliveries`), and its outcome is reported like a keystroke burst's (`cancelled` is silent, `failed` raises a notice). A message the spawn already took as its opening prompt is not pasted again.
- **On agent turn end:** awaited, after the turn's last paint.

### `run_script` -- Run script

Runs a script as an ordinary child process, in the task's worktree when it has one and the project checkout when it does not. There is no working-directory setting; the legacy `workingDir` key is ignored and dropped on save.

| Field | Type | Description |
|-------|------|-------------|
| `script` | string | The script body, with `{{placeholders}}`. Escaping is `shell` |
| `timeoutMinutes` | number | Give up after this long. Default 10, range 1 to 120. Set in `kangentic.json` only, not in the Column Manager: an exit group is capped at 60 seconds in aggregate whatever this says, so the control could not tell the truth on half the rows it appeared on. The bound itself is not optional, because enter automations hold the task lock and `withTaskLock` has no timeout of its own |

Not a PTY. An interactive shell runs the script and then returns to its prompt and lives forever, so completion is unobservable and the exit code unobtainable; this adapter awaits the exit and records the code. The timeout kills the process TREE, because a bare kill reaches the shell only and leaves whatever it spawned running. No retry: a half-run script is not safe to repeat.

Every variable also arrives as a `KANGENTIC_*` environment variable, which is the lossless path: `"$KANGENTIC_TITLE"` gets the exact value on a POSIX shell or PowerShell, where substituted text is stripped of shell metacharacters (including the curly double quotes, which PowerShell ends a string at). Not on cmd.exe, which expands `%KANGENTIC_TITLE%` and then re-parses the value for metacharacters.

### `webhook` -- Call webhook

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | Target URL. Escaping is `url` (percent-encoded) |
| `method` | `'POST'` \| `'GET'` \| `'PUT'` | Default `POST` |
| `body` | string | Request body. Escaping is `json`. Empty means the default JSON envelope |
| `headers` | Record<string, string> | Extra headers, authored one per line as `Name: Value` |

30 second timeout via `AbortSignal.timeout`, a `response.ok` check, and 3 attempts on a transport error, 408, 429 or 5xx through the runner's retry loop (`delayBeforeRetry` in `src/main/automations/automation-runner.ts`), honoring `Retry-After`. Every attempt sends an `Idempotency-Key` built from the run id, so a retry cannot double-create downstream. `attempts` is written to the run row.

### `notify` -- Notify me

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Default `{{title}}`. Escaping is `none` |
| `body` | string | Default `{{toColumn}}`. Escaping is `none` |

One desktop notification through the same `showDesktopNotification` path `DesktopNotifier` uses, so it inherits click-to-task, and the same Title and Body pushed to every paired phone, where a tap opens the task. Every place that builds an automation context wires `showNotification` to `showAutomationNotification` (`src/main/automations/shared/show-automation-notification.ts`), which does both. Neither reads the notification settings: the row is the user's choice to be told ([Push notifications](../../integrations/mobile-bridge/push-notifications.md)). No timeout, no retry.

### `move_to_column`: Move to column

| Field | Type | Description |
|-------|------|-------------|
| `targetColumn` | string | The destination column's name. Empty or absent is Next column: the column after the task's own (on its route in a workflow, else on the board), resolved by `resolveMoveTarget`, the same answer `kangentic_move_task`'s `column: "next"` gets. Renaming a column rewrites the rows that name it |
| `message` | string | Optional. Sent to the agent in the destination column once its turn ends, after that column's own On task enter rows. Escaping is `none`; a multi-line message (a review's `{{agentReply}}`) is pasted whole. When the destination runs no agent (a column that starts none, a paused agent, a spawn that failed), or the agent exits before its turn ends, the message is held for the task's next agent ([Held messages](../sessions/held-messages.md)). A move into Done holds nothing: the message is logged and dropped |

Offered on `turn_end` only: on enter or exit its move would run inside the move that fired it, under that move's own task lock. It moves through `context.moveTask`, which runs `handleTaskMove` with origin `'automation'` (a quiet push, `TASK_MOVED_BY_AUTOMATION`, and the row's name as the move's `task_moves` reason), so the source column's exit rows and the destination's enter rows run as they do for a drag. A row that runs ends its group (`endsGroup`). The message is handed on in the background (`deliverMessageAfterMove`), so the run row reads "Moved to Executing, with a message." as soon as the move commits rather than waiting out the destination agent's first turn. No timeout of its own and no retry: the move owns its deadlines.

### `spawn_agent` -- Start agent (legacy)

The one legacy adapter, kept because a row carrying a custom `promptTemplate` is not a duplicate of anything and has no other home. It is never offered for a new automation, appears as a disabled option in the dialog's Type select, and shows a lint on its row: "This is handled by the column's settings now. Remove it to use them." Its one field, `promptTemplate`, has escaping `none`.

`kill_session`, `create_worktree` and `cleanup_worktree` (`RETIRED_ACTION_TYPES`) are GONE, rows and all. Each was a no-op or a duplicate of the move path: `kill_session` suspended a session the task no longer had at that point, `create_worktree` did what `ensureTaskWorktree` does, and `cleanup_worktree` did what a To Do move does. `create_pr` was never implemented, and the migration drops it with any other type it does not recognize. A hand-written `kangentic.json` naming one of these is warned and skipped, matching what the migration did to the same row in the DB. `send_command` is not retired. The migration converted its rows to `send_message`, and a file that still names it is read as an alias (see [Configuration cascade](../../settings/cascade.md#column-automations)).

## Every row is isolated, bounded and recorded

`runAutomations` (`src/main/automations/automation-runner.ts`) is where the reliability promises live. Each was a live defect in the action system this replaces.

- **Isolated.** One throw used to abort the rest of the chain, and `agent-spawn.ts` then swallowed it while the move still resolved `ok`. Now each row is caught, its outcome recorded, and the next row runs. The rows are independent side effects; aborting means a webhook blip silently skips the agent message. The one real dependency stays expressed through `needs`.
- **Bounded.** Nothing timed out: `withTaskLock` is a PQueue with no timeout and Phase 3 holds it across the whole list, so one hung webhook wedged every later operation on that task until a restart. Each row now runs under its adapter's `timeoutMs`, combined with the move's own signal.
- **Recorded.** There was no run table at all, so "did my automation run" had no answer. Every row writes an `automation_runs` row: `running` before the attempt, closed on every exit path as `succeeded`, `failed`, `skipped` or `interrupted`, with a one-line `detail` (`HTTP 204`, `exit 0`, the skip reason, the error).

  A message reports **"Delivered" on exit and at a turn end, and "Sent" on enter**, and the difference is real rather than cosmetic. The exit hook awaits the keystroke burst, so the row is written only once it has gone out. The enter group cannot await: Phase 3 holds the task lock across it, and a deferred message waits for the agent's current turn to end, so awaiting would hold that lock for as long as the scheduler's ladder runs. Neither word is "Confirmed": only Claude implements a submission verifier, so on every other agent even the exit case is unconfirmed and the scheduler reports that outcome on its own channel.

The runner never throws for an automation's sake. It rethrows exactly one thing: an abort of the move itself.

### What the user sees

Nothing on success. A `failed` or `interrupted` run raises ONE error toast naming the task, the automation and the column, with a Run again action, behind a 60s cooldown keyed on the project and the AUTOMATION. Keyed on the automation rather than the task deliberately: a bulk move of twelve tasks through one column fails the same webhook twelve times, and the run rows record all twelve, which is where a count belongs. The toast names the first task, the one Run again acts on. It is persistent, so it outlives a project switch: its card opens the task through `openTaskFromNotification` (switching back to the task's project) and stays up, and Run again carries the failure's `projectId` rather than the project open at the click. The Column Manager row shows no run history (it used to print its last run under its sentence, which made rows in one list differ in height); the toast and `kangentic_get_automation_runs` are where "did my automation work" is answered. `emitSpawnProgress` carries the running row's name, which closes the gap where a column with `autoSpawn: false` and a slow webhook showed the user nothing at all.

**Run again re-executes ONE automation against the task's CURRENT state** and writes a fresh run row. The toast and the row both say "current state", because a task may have moved twice since the failure and re-running a stale context would be a worse lie than not offering it.

A Move to column row moves the task on Run again (and `kangentic_run_automation`) through the same move a turn end makes (`move-from-row.ts`). It runs outside the task lock, because `handleTaskMove` takes that lock and it is not reentrant, and it moves the task only from the row's own column: a task that has left it is refused with "The task is no longer in <column>, so this row cannot move it. Drag the card instead.", since Next column resolves from the row's column. A task that leaves between that check and the move is refused inside the task lock ("The task left <column> before it could be moved."). The move checks again inside its own lock (`handleTaskMove`'s `expectedFromSwimlaneId`), so a drag that lands while it waits refuses it rather than sending the task on from the new column. Every other row runs inside the lock.

### Interrupted runs and the project-open sweep

`synchronous-shutdown.md` forbids awaiting a drain on quit, so a `running` row at boot is a known orphan. In the same pass that runs `retryFailedDoneCleanups`, project open calls `markStaleRunsInterrupted()` and then `pruneTo(200)`. The first keeps the log honest; without it "these always run" is false on every restart. The second bounds a table nothing else bounds, keeping the rows a Frequency limit counts, a live workflow task's own rows in its current column, and the newest enter run of a task that never had an agent in its current column, which the startup reconcile reads (see [Crash recovery](../sessions/crash-recovery.md) step 8). If any row was interrupted, ONE summary toast, never one per row.

There is no automatic retry across a restart, ever. A fired webhook and a half-run script are not safe to repeat blind, so the user gets Run again on the row instead.

## Template Variables

One declaration (`src/shared/task-template-vars.ts`) drives every consumer: every
automation field that takes variables, the per-task `auto_command`, the legacy
`spawn_agent` automation's `promptTemplate`, the Column Manager's "Template
variable" picker and its inline `{{` completion, and this table - see
`tests/unit/task-template-vars-parity.test.ts`. Because the picker shows each
entry's `description`, that field is user-facing copy and should stay to one
line.

26 keywords. 19 resolve wherever there is a task, 5 only in an automation (the
move keywords and `{{agentReply}}`), and 2 only in a workflow agent's first
message (`{{columns}}` and `{{brief_xml}}`), each marked below. That first
message (Settings > Workflows) is the third context: it is written before any
task exists, so it offers only `{{projectName}}`, `{{projectPath}}`,
`{{baseBranch}}` (the project's default) and its own two.

**Two substitution rules, split by SOURCE rather than by destination.**

- **Every automation field** substitutes literally, through
  `interpolateAutomationConfig` -> `interpolateTemplate`: a known name is
  replaced, an unknown one is left exactly as written. That is what the field's
  own editor promises when it paints an unrecognized name amber and says
  "Unknown variable: nope. It will be sent as written."
- **A per-task `auto_command`** (MCP-only) and the legacy `spawn_agent`
  `promptTemplate` keep DROP-AND-COLLAPSE, through `interpolateTaskTemplate`:
  an unknown or empty `{{key}}` is dropped and the horizontal whitespace around
  it collapses, so `/code-review {{baseBranch}}` with no configured default
  yields `/code-review` rather than a trailing space.

The split is by source because the editor and the interpolator have to agree.
Nothing warns you about an empty keyword in an MCP-set `auto_command`, so
dropping it is the kinder behavior there; an automation field DOES warn, in the
dialog, before you save it.

Note what drop-and-collapse means for a FLAG-shaped placeholder in an
`auto_command`: `--port {{port}}` with no reservation collapses to a bare
`--port`, which most CLIs reject.

| Variable | Value |
|----------|-------|
| `{{title}}` | Task title (PTY-sanitized) |
| `{{description}}` | Task description with `: ` prefix when non-empty |
| `{{task_xml}}` | Task title and description wrapped in a `<task>` envelope (`<title>` / `<description>` children). Default seeded prompt template is `{{task_xml}}{{workflow_xml}}{{attachments}}`, which gives the agent a structured envelope without forcing the user to template it manually. |
| `{{workflow_xml}}` | A workflow task's `<workflow>` block: the workflow's name, the task's route, the `<column>` it is in as the prompt is built, the tasks it built on (with their branch and PR) and the tasks waiting on it, then how its turns are judged (end a turn only with the column's work done or when only the owner can settle what it is stuck on, and then with the `Needs owner: <the question>` line, for a change from the plan, something the owner must weigh in on, or a decision between options; progress notes go beside the next tool call; `kangentic_move_task` with `"next"`, or, in a column that runs the task in plan mode, that approving the plan moves the task on to the next route column so the agent does not move it itself; `kangentic_mark_background_service` for a background command left running after the turn; and which route columns run in a conversation of their own, an isolated session target: an agent in one is told the main conversation sees only its commits and its final message, and an agent in the main conversation is told those columns do not see it and that it hears what they did when it comes back). Read by the engine (`readWorkflowPromptFacts`, whose `ownConversation` lists those columns) and escaped. Empty, and dropped, for a task outside a workflow, so an ordinary task's default prompt is unchanged. |
| `{{taskId}}` | Task UUID |
| `{{taskNumber}}` | The task's `#N`, the number people say out loud (`display_id`) |
| `{{projectPath}}` | Main project checkout path (empty if no project is open) - always the base repo, even when the task has a worktree |
| `{{projectName}}` | The project's name as it reads in the sidebar (empty if no project is open) |
| `{{worktreePath}}` | Worktree directory path (empty if none) - a raw read, never falls back to a project-level path |
| `{{branchName}}` | Git branch name (empty if none) - a raw read, never falls back to a project-level branch |
| `{{baseBranch}}` | Effective base branch: the task's `base_branch` override, else the project's configured default (board config, then app config, then `'main'`) |
| `{{prUrl}}` | Pull request URL (empty if none) |
| `{{prNumber}}` | Pull request number as string (empty if none) |
| `{{prState}}` | Pull request state: `open`, `merged`, `closed` or `draft` (empty if none) |
| `{{issueKey}}` | The linked tracker issue's key, such as a Jira key or a GitHub issue number (empty if none) |
| `{{issueUrl}}` | The linked tracker issue's URL (empty if none) |
| `{{labels}}` | The task's labels, comma-separated (empty if none) |
| `{{attachments}}` | Bare file paths (one per line) when present |
| `{{port}}` | Lowest dev-server port this task has RESERVED (empty if none, which is the normal state) - a raw read, never falls back to another task's port |
| `{{column}}` | The column the automation belongs to. Automations only |
| `{{fromColumn}}` | The column the task moved out of (empty for a task born into a column). Automations only |
| `{{toColumn}}` | The column the task moved into. Automations only |
| `{{trigger}}` | When this automation runs: `enter`, `turn_end` or `exit`. Automations only |
| `{{agentReply}}` | The agent's reply at the end of its last turn in this column: the final message, full text with its line breaks. Empty on task enter, and for an agent whose transcript Kangentic cannot read. A Claude turn that wrote no text of its own is empty too (see the note below the table). Automations only |
| `{{columns}}` | One line per column between To Do and Done, in board order: what it runs (an agent, plan mode and whether the user or Kangentic approves the plan, its own session, a slash command), its enabled automations, and how many of the last 10 finished tasks went through it (from `task_moves`; left out until a task has finished). Names escaped. Workflow agent only |
| `{{brief_xml}}` | What the workflow was made from: a `<brief>` block with the source task's `<source_task>#N</source_task>`, `<title>` and `<description>`, laid out and escaped like `{{task_xml}}`. Empty, and dropped, for a workflow made from nothing. Workflow agent only |

The five marked **automations only** and the two marked **workflow agent only** are limited because each entry declares
its `contexts` (`src/shared/task-template-vars.ts`). A `spawn_agent` prompt
template is not a move, so those five would resolve permanently empty there,
and the picker does not offer them in that context. A flat list that offered
everything everywhere would be lying about five of its entries.

`{{agentReply}}` is read from the session whose turn just ended, which for an
isolated column is that column's own session, not the task's main one. Without
an anchor it is the same final answer `kangentic_get_transcript` returns for
`view: "result"`, uncut: the newest assistant message after the last user
prompt, its text blocks joined. `kangentic_get_transcript` takes no anchor, so
with one the two can differ on a turn that wrote no text. At a turn end it is
read from where that turn began (`transcriptAnchor`), so a Claude turn that
wrote no text of its own has an empty reply rather than the one an earlier turn
ended on. Claude is the only agent with the window read that honors an anchor;
the other agents with a transcript reader read the newest reply in it, which can
be an earlier turn's. It is what carries a review's findings to the column a
Move to column row sends the task to.

Drop-and-collapse preserves newlines: only runs of spaces and tabs collapse,
and only in the template's own text, never inside a substituted value. That is
what keeps a multi-line `{{task_xml}}` envelope intact down to a markdown hard
break in the raw description.

The flag-shaped case matters more than it used to, because Kangentic reserves
NOTHING up front. A port exists for a task only once its agent asked for one
(`kangentic_reserve_dev_ports`), so empty is the normal state, not the edge
case. A message shared by every task in a column therefore should
not template `{{port}}` in - most of those tasks hold no reservation. Prefer
letting the agent reserve the ports it is about to bind and use them directly;
reach for `{{port}}` only where the task is known to hold one.

`{{projectPath}}` is flag-shaped the same way, and fails less legibly than a
bare `--port` does. With no project open, `git -C {{projectPath}} merge main`
collapses to `git -C merge main`, so git takes the SUBCOMMAND as the `-C`
argument and reports `fatal: cannot change to 'merge'`. That is a loud failure,
not a silent one, but it names a directory nobody asked for instead of the
value that went missing. Path-valued keywords are also substituted unquoted, so
quote them yourself (`git -C "{{projectPath}}" merge main`) wherever the path
may contain spaces.

Shortcut commands use a separate set of template variables. See [Board config files](../../settings/board-config.md#shortcuts) for the full list.

## Stale Spawn Prevention (AbortSignal)

When a task moves rapidly between columns (e.g. user drags to the wrong column and immediately corrects), earlier transitions may still be in-flight when the new transition starts. Without cancellation, the old spawn would complete and create a PTY process that the new transition immediately supersedes.

The transition engine threads an `AbortSignal` through the execution chain:

- `runAutomations()` checks the signal before each row, and combines it with that row's own `timeoutMs` for the adapter
- `executeSpawnAgent()` checks the signal as a final gate before creating the PTY process

If the signal is aborted, the method throws an `AbortError` which the caller catches and ignores (the newer transition takes over). This prevents orphaned PTY processes from accumulating.

## The column's message on a move

When a task moves to a column whose On enter group holds a `send_message` automation, delivery depends on how the session was started. How a typed message is verified and retried is [Command injection](command-injection.md); this section is which message goes out, when, and when it is held back.

**Resumed sessions** (priority 3 suspend-and-resume, or priority 4 resume from suspended):
- The message is interpolated and passed as the resume prompt (`claude --resume <id> -- "..."`) when the adapter's resume carries one (`resumePromptDelivery: 'command-line'`) and it rides whole: a multi-line message keeps its lines, it does not open with `-`, and it fits under 6,000 characters (`resumePromptRidesCommandLine`). This is deterministic: the message is the first thing the agent sees on resume
- Otherwise the resume opens idle with no prompt, the engine hands the message back in `SpawnOutcome.unsentPrompt`, and `spawnAgent` types it in once the agent is ready, as on a fresh spawn. Copilot, Grok, OpenCode and Cursor always take this path. See [How the resume prompt arrives](../sessions/resume.md#how-the-resume-prompt-arrives)
- Two cases do not send the message as the resume prompt. If the agent deleted the conversation on a task's main session, the spawn starts fresh with a recap of the task, and the message is withheld and recorded as skipped "Not sent". If the conversation never started, the spawn is fresh and the message goes out after it. See [Resume](../sessions/resume.md#a-resume-the-cli-cannot-serve-starts-fresh-instead).

**Fresh spawns** (priority 4, no suspended session to resume):
- `TerminalSubmitScheduler.scheduleKeystrokes` schedules the message for deferred PTY injection
- Interpolates the message with task variables
- Waits for the CLI's first `'thinking'` activity event, then delivers via `TerminalSubmit.submitKeystrokes` as a handshake chain (drain + output-settle between keystrokes) rather than fixed sleeps
- A message with more than one line, or over 1,000 characters, is pasted instead, once the agent's first turn ends, unless it opens with a slash command (see [`send_message`](#send_message----send-message-to-agent))

If keystroke delivery cannot be confirmed in the agent's transcript, it escalates to a session restart that passes the command as the CLI's prompt argument - the same guarantee the resumed path has. Only an adapter whose resume carries a prompt escalates; on any other, the restart would only type the command again, so an unconfirmed command ends `failed`. Every injection ends in a recorded outcome on the task, and a failure raises a notice instead of a console warning. The full contract, including the delivery ladder, the prompt-state policy, and the measured before/after delivery rate, is in [Command Injection](command-injection.md).

Each message declares WHEN it fires, via its own `mode` field: `immediate` (the default; interrupts the agent's current turn if there is one) or `deferred` (holds until that turn genuinely finishes). "Finishes" requires activity `idle` AND a quiet PTY, because a bare idle is reported for minutes during an API retry backoff or a `Monitor` wait. This was `Swimlane.auto_command_mode`, a per-column field; it belongs to the automation now, so a column can hold an immediate message and a deferred one.

This enables workflows like moving a task from "Running" to "Code Review" to automatically send a review prompt to the agent.

`resolveColumnMessage` picks the column's message: the FIRST enabled `send_message` row in its On enter group. First, not all of them, because the two callers that ask are asking a question with one answer. A spawn has a single prompt slot, and the live injection types exactly one command. Later message rows are the runner's to deliver. A first row with a Condition or a Frequency limit comes back `guarded`, and the live injection and the handoff leave it unsent, because only the runner applies those two: a warm move lets the enter group send it after both checks, and a handoff, which runs no enter group, does not send it. `resolveEffectiveAutoCommand` then puts a per-task `auto_command` (MCP-only, `kangentic_create_task`'s `autoCommand` param) ahead of it for that task.

**A profile cannot re-point the message.** Automations are shared by every profile, which is why the Column Manager's whole list is read-only under one. `BoardProfileEntry.autoCommand` is the retired key that used to overlay it: nothing reads it, and nothing writes it. A column's own legacy `autoCommand` in `kangentic.json` IS still read, and converted into a `send_message` row on apply.

The unarchive handlers (`TASK_UNARCHIVE` / `TASK_BULK_UNARCHIVE`) and any other move out of Done suppress delivery via `spawnAgent`'s `suppressAutoCommand` (the recovery-move contract; see [Resume](../sessions/resume.md#resume)). That reaches the runner as `suppressAgentMessages`, which SKIPS every row whose adapter `needs` the agent, recording "Restoring a task from Done does not message the agent. The next move does." The skip belongs in the runner rather than in `deliverToAgent`'s own no-op, because a silent no-op lets `send_message` return normally and the row records "Delivered" for a message nobody received. It also runs before the agent-start step, so a message that is going to be skipped no longer spawns an agent to be skipped at. Every other type still runs: the suppression is about the agent's attention, not about the move.

A move of a task whose agent is held paused (`isHeldPause`) passes `agentPaused` instead: Priority 4 of `handleTaskMove` arms the destination's enter rows with no `startAgent` and spawns nothing, since a move never starts a paused agent. The runner skips each row that needs the agent with "The agent is paused. This row runs if the agent is resumed in this column." and runs the rest, and a skipped row asks no Condition. The user's Resume in that column runs those rows: `resumeTaskSession` calls `spawnAgent` with `resumesEntry`, whose enter group passes `executeTransition` `onlyRowsNeedingAgent`, so the rows that ran at the entry do not run twice (see [Resume](../sessions/resume.md#where-resume-is-refused)).

A legacy `spawn_agent` automation that creates the session itself runs its own prompt template, and the fallback message / continuation injection is skipped for that spawn. This is uniform across every entry point (move, create, promote, MCP create), since all route through `spawnAgent`, whose fallback start only fires when no automation spawned the session. The task's own `auto_command` is the exception: when a legacy Start agent row, or a Send message row with no text, started the agent and no row sent it, it still goes out once after the enter group, unless the task's main session started over on an expired conversation's recap or the move was superseded. A fresh board is unaffected: nothing is seeded any more.

**On exit, a message is awaited rather than scheduled.** Every priority branch below the Phase 1 hook opens with `terminalSubmitScheduler.cancel(task.id)` before it kills, suspends or re-points the session, so a burst merely SCHEDULED in the hook is cancelled a few milliseconds later, mid-burst, by the very move that asked for it. Measured against a live session, the run row read `succeeded` in one millisecond while the agent received the burst's leading Ctrl+U and nothing else, ever. `deliverExitMessage` (`src/main/ipc/helpers/exit-message-delivery.ts`) now awaits the scheduler's own outcome, bounded by the run's signal, which is the 60s exit budget. The enter path deliberately does NOT await: nothing there cancels, and awaiting would hold Phase 3's lock across a 120s deferred wait.

## Swimlane Roles

Two special roles affect behavior:

| Role | Behavior |
|------|----------|
| `todo` | Task moves here → session killed (not suspended), leftover processes reaped, worktree removed |
| `done` | Task moves here → session suspended (resumable), leftover processes reaped, worktree directory removed (retried once 10 s later if the removal fails), task archived |

Both roles still run their On EXIT group (in Phase 1, before the kill or the suspend), and neither runs an On enter group: the Column Manager offers only the exit group there, and `canColumnRun` blocks an enter row written by hand.

All other columns (including Planning, Executing, Code Review, etc.) are custom columns with no special role. Their behavior is controlled by `auto_spawn`, their automations, `permission_mode`, `plan_exit_target_id`, and `plan_approval`.

## auto_spawn Flag

Each swimlane has an `auto_spawn` boolean (default: `true`):
- `true` -- tasks in this column should have active sessions. Session recovery and reconciliation will spawn agents here.
- `false` -- tasks in this column should NOT have active sessions. Moving a task here suspends its session.

To Do and Done columns have `auto_spawn=false` by default.

### Changing the flag applies immediately

Editing `auto_spawn` reconciles the tasks ALREADY in the column, with no restart
and no move: switching it on spawns for each task that has no session, and
switching it off suspends the live sessions there. This runs through
`reconcileAutoSpawnChange` (`src/main/ipc/handlers/auto-spawn-reconcile.ts`),
dispatched from `propagateStrategyToLiveSessions`, so all four authoring surfaces
behave identically on the ACTIVE project:

- the Board Manager's column edit (`SWIMLANE_UPDATE`),
- the Board Manager's Board Profile edit (`BOARD_CONFIG_SET_BOARD_PROFILES`) -
  `auto_spawn` is profile-scoped, so a profile can flip it for a task without the
  column changing,
- the MCP `kangentic_update_column` tool,
- the MCP profile tools (`kangentic_update_board_profile`,
  `kangentic_delete_board_profile`, `kangentic_create_board_profile`), which
  reach the same reconcile through `setBoardProfiles`.

An MCP tool can also target a background project via its `project` argument; that
writes the setting without reconciling. The reason is BLAST RADIUS, not an absent
session: a background project can have live sessions (the Agent Monitor and the
sidebar's per-project agent counts are built on exactly that). The reconcile
SPAWNS, and a spawn creates a worktree and checks out a branch in a checkout the
user is not looking at. Its tasks pick the new setting up when they next spawn.
The cost is that turning `auto_spawn` off on a non-focused project leaves that
project's agents running until it is next opened.

Three things it deliberately does not do. A task the user explicitly paused is
never started by a column edit; only an explicit Resume clears that. A To Do or
Done column never spawns, whatever the flag says: the Board Manager and
`apply-config.ts` both force `auto_spawn` false for a role column, but the MCP
`update_column` tool writes the field with no role validation, so the reconcile
guards the ON direction itself. Only the ON direction is guarded, since
suspending a session that should not have been there is always safe. And the
`kangentic.json` file watcher (`BOARD_CONFIG_APPLY`) does NOT reconcile, so a
`git pull` that flips `autoSpawn` still takes effect on the next project open -
that path fires for whichever project changed on disk, which is often not the
focused one.

## plan_exit_target_id

When a column has `permission_mode='plan'`, Claude runs in plan mode. When the plan is approved, Kangentic moves the task to the column specified by `plan_exit_target_id`, folded through the task's Board Profile. A workflow task goes to the next column on its route instead (`planExitTargetFor`, `src/main/ipc/helpers/plan-exit-target.ts`). No target means the task stays.

The move is keyed on the approval, not on the agent calling `ExitPlanMode`. The `plan-exit` listener (`ipc/handlers/sessions.ts`) fires on the tool's completion (`PostToolUse`), which the CLI sends only for an approved plan, so a rejected plan moves nothing. That holds whoever approves.

Who approves is the column's `plan_approval`. `manual` (the default) waits for the user in the agent's terminal. `automatic` has Kangentic answer the prompt through the agent's plan approval hook, for an agent that declares `supportsPlanAutoApproval` (see [Bridge scripts](../../integrations/agents/bridge-scripts.md#plan-approval-bridgejs)). A workflow task follows its own `plan_approval` instead, else the plan columns on its route (`taskPlanApproval`, `src/shared/plan-approval.ts`), and an agent that cannot approve plans, or a task with its automations disabled, always waits for the user. Kangentic's approval also switches the session to the permission mode it would spawn with in the destination column, with fallbacks when that is `plan` (see [Bridge scripts](../../integrations/agents/bridge-scripts.md#plan-approval-bridgejs)). Besides the plan prompt, the hook answers only a planning prompt for another MCP server's tool the allow rules in the project's or the user's Claude settings name, which Claude's plan mode asks about anyway (task #870), so an unattended Planning session does not stall on a tool you allowed. A question the agent asks the user, any other tool, and Kangentic's own tools still wait.

Default setup: Planning column has `plan_exit_target_id` pointing to the Executing column.

## Default Seed Configuration

New projects get seven columns and NO automations. Every column's list starts empty.

The two rows the seed used to write were both dead weight. `* -> Planning: Kill Session` ran at Priority 4, where the task has no active session, so it found nothing to suspend and did nothing at all. `Start Planning Agent` carried `{{task_xml}}{{attachments}}`, which was then exactly what the fallback spawn used when nothing supplied a prompt (the default has since gained `{{workflow_xml}}`; the migration compares against the literal the seed wrote), so it duplicated what the column's own "Start an agent here" setting already produces.

Seeding them also taught the wrong model: it made starting an agent look like an automation a user could reorder or delete, when it is a column setting. An empty list is both true and the right blank page to start from. `tests/unit/default-swimlanes-seed-parity.test.ts` pins it.

## Cross-Agent Handoff

When a task moves to a column with a different agent (detected by `resolveTargetAgent()` in `src/main/transition-engine/agent-resolver.ts`), a cross-agent handoff occurs:

1. **Agent resolution** detects agent change: `resolveTargetAgent()` checks `task.agent_override` first (highest priority - the user's create-time lock), then column `agent_override`, then project `default_agent`, then global fallback (`'claude'`). If the resolved agent differs from the current session's agent, a handoff is triggered. Tasks with a non-null `task.agent_override` never trigger a handoff on column moves - the locked agent supersedes column settings.
2. **Task-move Priority 3** suspends the current session.
3. **spawnAgent handoff path** - the `agentOverride` parameter is passed to `executeSpawnAgent()`, which prevents resume of the wrong agent's session.
4. **`spawnAgent` locates the previous session's history** (`src/main/ipc/helpers/agent-spawn.ts`): the source agent's adapter finds its native session file (`locateSessionHistoryFile`), and `buildSessionHistoryReference()` turns that path into a prompt telling the target agent to read it. A `handoffs` row records the from and to agents.
5. **Transition engine** spawns the new agent through `resumeSuspendedSession()` with that prompt as `handoffPromptPrefix`, prepended to the task prompt, and the `handoffs` row is updated with the new session.

Spawn progress phases during handoff: `packaging-handoff` (while the session file is located and the prompt built), `detecting-agent` (while the target agent CLI is detected), then `starting-agent`. The full flow, the per-agent file locations and the passthrough toggle are in [Cross-agent handoff](../../integrations/agents/handoff.md).

Because create-into-spawn-column and unarchive route through the same `spawnAgent` chokepoint as task moves, handoff semantics apply on those paths too: unarchiving a task into a column whose resolved agent differs from `task.agent` points the new agent at the previous agent's session history when the column's `handoff_context` toggle is enabled, and spawns the new agent fresh (no history) when it is disabled. The full entry-point table lives in [Spawn flow](../sessions/spawn-flow.md#spawn-entry-points).

## See Also

- [Sessions](../sessions/index.md) -- spawn entry points, spawn flow, queue, suspend, resume
- [Agents](../../integrations/agents/index.md) -- command building, permission modes, per-agent CLI details
- [Worktrees](../worktrees/index.md) -- worktree creation details
- [Database](../../database/index.md) -- schema for `column_automations`, `automation_runs`, swimlanes
- [Configuration cascade](../../settings/cascade.md#column-automations) -- the `kangentic.json` shape for a column's lists
