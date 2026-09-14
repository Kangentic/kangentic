# Transition Engine

`src/main/transition-engine/transition-engine.ts`

The transition engine runs a column's automations when tasks move between swimlanes. It handles the logic that makes Kanban columns "active" -- spawning agents, sending messages, running scripts, calling webhooks, and raising notifications.

Each column owns ONE ordered list, split into an On enter group and an On exit group. An automation belongs to exactly one column: there are no `from -> to` pairs and no shared, named actions. Every type is an adapter under `src/main/automations/adapters/`, declared once in `AUTOMATION_MANIFEST` (`src/shared/automation-manifest.ts`), and the engine dispatches through `automationRegistry`. Users edit the lists in the Column Manager; the file format is [Configuration](configuration.md#column-automations) and the tables are [Database](database.md).

## Priority Rules on Task Move

When a task moves from one column to another, the IPC handler (`task:move`) checks these conditions in order. The first match wins:

| Priority | Condition | Action |
|----------|-----------|--------|
| 1 | Target is **To Do** (role=`todo`) | Kill session, preserve worktree |
| 2 | Target is **Done** (role=`done`) | Suspend session (resumable), archive task |
| 2.5 | Target has `auto_spawn=false` (non-todo, non-done) | Suspend session |
| 3 | Task has **active session** | Permission-mode delta suspends and respawns with the destination's CLI flags. Live injection plan injects into the running session. Model/effort delta without live-swap suspends and respawns. Otherwise keep alive. |
| 4 | Task has **no session** | Resume suspended session (with the column's message preloaded as resume prompt) OR create worktree (if enabled) + run the destination's On enter group |

The SOURCE column's On exit group runs ahead of all five, in Phase 1. See [Triggers](#triggers).

### Priority 3: Active Session Handling

Priority 3 has five sub-cases, checked in order:

**a) Agent change (handoff):** If `resolveTargetAgent()` returns a different agent than the current session's agent, the session is suspended and the engine falls through to the `spawnAgent` path. The `agentOverride` parameter is set on the spawn request to prevent the new session from resuming the old agent's session. **Side effect:** per-task `model_override` and `effort_override` are cleared on handoff because override values are model-name-specific and don't carry across agents (Claude's `claude-sonnet-4-6` is meaningless to Codex). This clear is skipped when `task.agent_override` is set, since the user locked the agent at creation and the overrides remain valid for that agent. If the target column has `handoff_context` enabled, prior work context (transcript, git diff, metrics) is packaged and delivered to the new agent. If disabled (the default), the new agent starts fresh with just the task title/description. See [Cross-Agent Handoff](#cross-agent-handoff) below.

**b) Same agent + permission-mode delta:** If the destination column's EFFECTIVE permission mode (`lane.permission_mode ?? config.agent.permissionMode`) differs from the mode the live session was spawned with (the session record's `permission_mode`, not the source lane), the session is suspended and respawned. No adapter exposes a non-interactive permission-mode switch for a live session (Claude's only mechanism is interactive shift+tab cycling), so this is checked before live injection. The respawn resumes the same agent session id, and the destination's `--permission-mode` / `--model` / `--effort` land as CLI flags. Legacy session records with a null `permission_mode` never trigger this case. A plan-exit auto-move additionally passes a continuation prompt ("Your plan was approved. Proceed with the implementation.") delivered as the resumed session's first message when the destination column has no `auto_command` (the `auto_command` wins when present).

**c) Same agent + live injection plan:** If the destination adapter returns a non-null plan from `prepareInjectionPlan` (model/effort slash commands like `/model X` + optional auto_command), the writes are scheduled directly into the running session via `TerminalSubmitScheduler.scheduleKeystrokes`. No suspend/resume cycle occurs. The delta is computed against what the session is *actually running at*, not the leaving column, so a column whose value the session already has injects nothing. The two fields resolve that differently: **model** uses the session record's `applied_model`, while **effort** prefers the level the agent itself reports (`task.effort_override ?? <agent-reported effort> ?? record.applied_effort`), because `applied_effort` records only what Kangentic last asked for and an `/effort` typed straight into the terminal never reaches it. Model deliberately stays record-only - telemetry reports canonical ids while the configured values are flag strings, so comparing them would read a false change and restart the PTY. See [Command Injection](command-injection.md) for the full precedence. After scheduling, when `plan.appliedSettings` is present the handler persists it via `sessionRepo.updateAppliedSettings`, keeping the recorded value current so the next move diffs against the truth.

**d) Same agent + concrete model/effort delta (no live-swap):** If the adapter has no live-swap slash for the target value AND the destination column overrides model or effort to a non-null value the session is not already running at (the delta is computed against what the session is actually running at, not the source lane: `applied_model` for model, and `task.effort_override ?? <agent-reported effort> ?? record.applied_effort` for effort, matching case (c) above), the session is suspended and respawned so the new flags land on the command line. The respawn is skipped when the target value is null (entering a "Default" column) because adapters have no `/model <agent-default>` slash and `--resume <id>` preserves the saved model regardless - the suspend/resume would just churn the PTY without changing anything. Matches the recovery contract in `task-runtime-override.ts`.

**e) Same agent, no delta or no concrete target:** The session stays alive with no interruption.

## Triggers

An automation's `trigger` is `enter` or `exit`, and it means any move into or out of the column it belongs to. There is no `from -> to` pair and no wildcard, because a list belongs to one column rather than to a lane pair.

**On exit runs in Phase 1**, inside the short task lock, after the DB write and the `board:changed` emit and BEFORE the priority branches. That order is load-bearing: Priority 1 kills the session, so an exit automation that needs the agent has to find it still attached. Two consequences:

- **An exit automation never aborts the move.** The rollback only reverts Phase 2 and Phase 3, and the group runs after the commit point. A throw, a timeout, or the whole group failing records its outcome and the move proceeds to its priority branch.
- **The exit group is capped at 60 seconds in aggregate** (`EXIT_GROUP_BUDGET_MS`), overriding the adapters' own budgets, because holding the short lock is what wedges that task's next move. A row that would exceed the cap is recorded `failed` with "Exit automations are capped so the board stays responsive." Exit is for quick handoffs; long work belongs on enter, where Phase 3 already holds the lock across the spawn and has a progress spinner to show for it.

**On enter runs at both of the destination's session paths.** Priority 3's two keep-alive returns run the group against the live session (`runWarmEnterAutomations`), and Priority 4 runs it with the fallback spawn handed in as `startAgent`. To Do and Done run exit rows only: an enter automation can never fire there, so the Column Manager does not offer the group and `canColumnRun` blocks one written by hand.

## The agent starts on demand

Nothing in a list starts the agent explicitly. An adapter declares what it `needs` (only `send_message` needs `'agent'`), and on enter the runner calls `startAgent()` once, right before the first row that needs it. If no row needed it, the caller's fallback spawn runs after the list as it always did.

On exit there is no `startAgent`: the task is leaving, so a row that needs an agent the task does not have is recorded `skipped` with the reason rather than starting one.

A column that cannot meet a need shows the row switched off with its switch disabled (Start an agent here is off), and the draft keeps the stored `enabled` so turning the setting back on restores it.

## Automation adapters

Five types, four of them offered for a new automation. Each declares its fields, its per-field escaping, its timeout and its retry policy in `AUTOMATION_MANIFEST`, which the renderer reads for the picker, the Edit automation dialog and the row sentence. `tests/unit/automation-adapter-parity.test.ts` fails if the registry and the manifest disagree.

### `send_message` -- Send message to agent

Delivers an interpolated message to the task's agent. This is what the retired `Swimlane.auto_command` became: the migration moved every column's message into one of these.

| Field | Type | Description |
|-------|------|-------------|
| `message` | string | The text, with `{{placeholders}}`. Escaping is `none`, because it is prose going to an agent |
| `mode` | `'immediate'` \| `'deferred'` | Run immediately (interrupts the current turn) or wait for the current turn |

Needs the agent. No timeout of its own beyond the scheduler's 120s, and no retry: `TerminalSubmitScheduler` already has a confirmation verifier and a one-shot escalation ladder. Delivery goes through `context.deliverToAgent`, which applies the three rungs when this run started the agent and the plain scheduled keystroke otherwise. See [Command Injection](command-injection.md).

### `run_script` -- Run script

Runs a script as an ordinary child process, in the task's worktree when it has one and the project checkout when it does not. There is no working-directory setting; the legacy `workingDir` key is ignored and dropped on save.

| Field | Type | Description |
|-------|------|-------------|
| `script` | string | The script body, with `{{placeholders}}`. Escaping is `shell` |
| `timeoutMinutes` | number | Give up after this long. Default 5 |

Not a PTY. An interactive shell runs the script and then returns to its prompt and lives forever, so completion is unobservable and the exit code unobtainable; this adapter awaits the exit and records the code. The timeout kills the process TREE, because a bare kill reaches the shell only and leaves whatever it spawned running. No retry: a half-run script is not safe to repeat.

Every variable also arrives as a `KANGENTIC_*` environment variable, which is the lossless path: `"$KANGENTIC_TITLE"` gets the exact value on every shell, where substituted text is stripped of shell metacharacters.

### `webhook` -- Call webhook

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | Target URL. Escaping is `url` (percent-encoded) |
| `method` | `'POST'` \| `'GET'` \| `'PUT'` | Default `POST` |
| `body` | string | Request body. Escaping is `json`. Empty means the default JSON envelope |
| `headers` | Record<string, string> | Extra headers, authored one per line as `Name: Value` |

30 second timeout via `AbortSignal.timeout`, a `response.ok` check, and 3 attempts on a transport error, 429 or 5xx through the shared `withBackoff`, honoring `Retry-After`. Every attempt sends an `Idempotency-Key` built from the run id, so a retry cannot double-create downstream. `attempts` is written to the run row.

### `notify` -- Notify me

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Default `{{title}}` |
| `body` | string | Default `{{toColumn}}` |

One desktop notification through the same `showNotification` path `DesktopNotifier` uses, so it inherits click-to-task. No timeout, no retry.

### `spawn_agent` -- Start agent (legacy)

The one legacy adapter, kept because a row carrying a custom `promptTemplate` is not a duplicate of anything and has no other home. It is never offered for a new automation, appears as a disabled option in the dialog's Type select, and shows a lint on its row: "This is handled by the column's settings now. Remove it to use them."

`send_command`, `kill_session`, `create_worktree`, `cleanup_worktree` and `create_pr` are GONE, rows and all. Each was a no-op or a duplicate of the move path: `kill_session` suspended a session the task no longer had at that point, `create_worktree` did what `ensureTaskWorktree` does, `cleanup_worktree` did what a To Do move does, and `create_pr` was never implemented. A hand-written `kangentic.json` naming one is warned and skipped, matching what the migration did to the same row in the DB.

## Every row is isolated, bounded and recorded

`runAutomations` (`src/main/automations/automation-runner.ts`) is where the reliability promises live. Each was a live defect in the action system this replaces.

- **Isolated.** One throw used to abort the rest of the chain, and `agent-spawn.ts` then swallowed it while the move still resolved `ok`. Now each row is caught, its outcome recorded, and the next row runs. The rows are independent side effects; aborting means a webhook blip silently skips the agent message. The one real dependency stays expressed through `needs`.
- **Bounded.** Nothing timed out: `withTaskLock` is a PQueue with no timeout and Phase 3 holds it across the whole list, so one hung webhook wedged every later operation on that task until a restart. Each row now runs under its adapter's `timeoutMs`, combined with the move's own signal.
- **Recorded.** There was no run table at all, so "did my automation run" had no answer. Every row writes an `automation_runs` row: `running` before the attempt, closed on every exit path as `succeeded`, `failed`, `skipped` or `interrupted`, with a one-line `detail` (`HTTP 204`, `exit 0`, the skip reason, the error).

The runner never throws for an automation's sake. It rethrows exactly one thing: an abort of the move itself.

### What the user sees

Nothing on success. A `failed` or `interrupted` run raises ONE error toast naming the automation and the column, with a Run again action, behind a 60s cooldown keyed on the project and the AUTOMATION. Keyed on the automation rather than the task deliberately: a bulk move of twelve tasks through one column fails the same webhook twelve times, and the run rows record all twelve, which is where a count belongs. The Column Manager row shows its last run under its sentence, so "did my automation work" is answered where the automation lives. `emitSpawnProgress` carries the running row's name, which closes the gap where a column with `autoSpawn: false` and a slow webhook showed the user nothing at all.

**Run again re-executes ONE automation against the task's CURRENT state** and writes a fresh run row. The toast and the row both say "current state", because a task may have moved twice since the failure and re-running a stale context would be a worse lie than not offering it.

### Interrupted runs and the project-open sweep

`synchronous-shutdown.md` forbids awaiting a drain on quit, so a `running` row at boot is a known orphan. In the same pass that runs `retryFailedDoneCleanups`, project open calls `markStaleRunsInterrupted()` and then `pruneTo(200)`. The first keeps the log honest; without it "these always run" is false on every restart. The second bounds a table nothing else bounds. If any row was interrupted, ONE summary toast, never one per row.

There is no automatic retry across a restart, ever. A fired webhook and a half-run script are not safe to repeat blind, so the user gets Run again on the row instead.

## Template Variables

One declaration (`src/shared/task-template-vars.ts`) drives every consumer: every
automation field that takes variables, the per-task `auto_command`, the legacy
`spawn_agent` automation's `promptTemplate`, the Column Manager's "Template
variable" picker and its inline `{{` completion, and this table - see
`tests/unit/task-template-vars-parity.test.ts`. Because the picker shows each
entry's `description`, that field is user-facing copy and should stay to one
line.

22 keywords, of which 18 resolve everywhere and 4 only in an automation (the
move keywords, marked below).

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
| `{{task_xml}}` | Task title and description wrapped in a `<task>` envelope (`<title>` / `<description>` children). Default seeded prompt template is `{{task_xml}}{{attachments}}`, which gives the agent a structured envelope without forcing the user to template it manually. |
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
| `{{trigger}}` | Which end of the move this is: `enter` or `exit`. Automations only |

The last four are marked **automations only** because each entry declares
its `contexts` (`src/shared/task-template-vars.ts`). A `spawn_agent` prompt
template is not a move, so those four would resolve permanently empty there,
and the picker does not offer them in that context. A flat list that offered
everything everywhere would be lying about four of its entries.

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

Shortcut commands use a separate set of template variables. See [Configuration](configuration.md#shortcuts) for the full list.

## Stale Spawn Prevention (AbortSignal)

When a task moves rapidly between columns (e.g. user drags to the wrong column and immediately corrects), earlier transitions may still be in-flight when the new transition starts. Without cancellation, the old spawn would complete and create a PTY process that the new transition immediately supersedes.

The transition engine threads an `AbortSignal` through the execution chain:

- `runAutomations()` checks the signal before each row, and combines it with that row's own `timeoutMs` for the adapter
- `executeSpawnAgent()` checks the signal as a final gate before creating the PTY process

If the signal is aborted, the method throws an `AbortError` which the caller catches and ignores (the newer transition takes over). This prevents orphaned PTY processes from accumulating.

## Command Injection

When a task moves to a column whose On enter group holds a `send_message` automation, delivery depends on how the session was started:

**Resumed sessions** (priority 3 suspend-and-resume, or priority 4 resume from suspended):
- The message is interpolated and passed as the resume prompt to `claude --resume <id>`
- This is deterministic: the message is the first thing the agent sees on resume

**Fresh spawns** (priority 4, no suspended session to resume):
- `TerminalSubmitScheduler.scheduleKeystrokes` schedules the message for deferred PTY injection
- Interpolates the message with task variables
- Waits for the CLI's first `'thinking'` activity event, then delivers via `TerminalSubmit.submitKeystrokes` as a handshake chain (drain + output-settle between keystrokes) rather than fixed sleeps

If keystroke delivery cannot be confirmed in the agent's transcript, it escalates to a session restart that passes the command as the CLI's prompt argument - the same guarantee the resumed path has. Every injection ends in a recorded outcome on the task, and a failure raises a notice instead of a console warning. The full contract, including the delivery ladder, the prompt-state policy, and the measured before/after delivery rate, is in [Command Injection](command-injection.md).

Each message declares WHEN it fires, via its own `mode` field: `immediate` (the default; interrupts the agent's current turn if there is one) or `deferred` (holds until that turn genuinely finishes). "Finishes" requires activity `idle` AND a quiet PTY, because a bare idle is reported for minutes during an API retry backoff or a `Monitor` wait. This was `Swimlane.auto_command_mode`, a per-column field; it belongs to the automation now, so a column can hold an immediate message and a deferred one.

This enables workflows like moving a task from "Running" to "Code Review" to automatically send a review prompt to the agent.

`resolveColumnMessage` picks the column's message: the FIRST enabled `send_message` row in its On enter group. First, not all of them, because the two callers that ask are asking a question with one answer -- a spawn has a single prompt slot, and the live injection bundles one command into the model/effort keystroke burst. Later message rows are the runner's to deliver. `resolveEffectiveAutoCommand` then puts a per-task `auto_command` (MCP-only, `kangentic_create_task`'s `autoCommand` param) ahead of it for that task.

**A profile cannot re-point the message.** Automations are shared by every profile, which is why the Column Manager's whole list is read-only under one. `BoardProfileEntry.autoCommand` is the retired key that used to overlay it: nothing reads it, and nothing writes it. A column's own legacy `autoCommand` in `kangentic.json` IS still read, and converted into a `send_message` row on apply.

The unarchive handlers (`TASK_UNARCHIVE` / `TASK_BULK_UNARCHIVE`) and any other move out of Done suppress delivery via `spawnAgent`'s `suppressAutoCommand` (the recovery-move contract; see [Session Lifecycle](session-lifecycle.md#resume)). That reaches the runner as `suppressAgentMessages`, which SKIPS every row whose adapter `needs` the agent, recording "Restoring a task from Done does not message the agent. The next move does." The skip belongs in the runner rather than in `deliverToAgent`'s own no-op, because a silent no-op lets `send_message` return normally and the row records "Delivered" for a message nobody received. It also runs before the agent-start step, so a message that is going to be skipped no longer spawns an agent to be skipped at. Every other type still runs: the suppression is about the agent's attention, not about the move.

A legacy `spawn_agent` automation that creates the session itself runs its own prompt template, and the fallback message / continuation injection is skipped for that spawn. This is uniform across every entry point (move, create, promote, MCP create), since all route through `spawnAgent`, whose fallback delivery only fires when no automation spawned the session. A fresh board is unaffected: nothing is seeded any more.

**On exit, a message is awaited rather than scheduled.** Every priority branch below the Phase 1 hook opens with `terminalSubmitScheduler.cancel(task.id)` before it kills, suspends or re-points the session, so a burst merely SCHEDULED in the hook is cancelled a few milliseconds later, mid-burst, by the very move that asked for it. Measured against a live session, the run row read `succeeded` in one millisecond while the agent received the burst's leading Ctrl+U and nothing else, ever. `deliverExitMessage` (`src/main/ipc/helpers/exit-message-delivery.ts`) now awaits the scheduler's own outcome, bounded by the run's signal, which is the 60s exit budget. The enter path deliberately does NOT await: nothing there cancels, and awaiting would hold Phase 3's lock across a 120s deferred wait.

## Swimlane Roles

Two special roles affect behavior:

| Role | Behavior |
|------|----------|
| `todo` | Task moves here → session killed (not suspended), worktree preserved |
| `done` | Task moves here → session suspended (resumable), task archived |

Both roles still run their On EXIT group (in Phase 1, before the kill or the suspend), and neither runs an On enter group: the Column Manager offers only the exit group there, and `canColumnRun` blocks an enter row written by hand.

All other columns (including Planning, Executing, Code Review, etc.) are custom columns with no special role. Their behavior is controlled by `auto_spawn`, their automations, `permission_mode`, and `plan_exit_target_id`.

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

When a column has `permission_mode='plan'`, Claude runs in plan mode. When the agent completes planning and fires `ExitPlanMode`, Kangentic detects this via the event bridge and automatically moves the task to the column specified by `plan_exit_target_id`.

Default setup: Planning column has `plan_exit_target_id` pointing to the Executing column.

## Default Seed Configuration

New projects get seven columns and NO automations. Every column's list starts empty.

The two rows the seed used to write were both dead weight. `* -> Planning: Kill Session` ran at Priority 4, where the task has no active session, so it found nothing to suspend and did nothing at all. `Start Planning Agent` carried `DEFAULT_SPAWN_PROMPT_TEMPLATE` (`{{task_xml}}{{attachments}}`), which is exactly what the fallback spawn uses when nothing supplies a prompt, so it duplicated what the column's own "Start an agent here" setting already produces.

Seeding them also taught the wrong model: it made starting an agent look like an automation a user could reorder or delete, when it is a column setting. An empty list is both true and the right blank page to start from. `tests/unit/default-swimlanes-seed-parity.test.ts` pins it.

## Cross-Agent Handoff

When a task moves to a column with a different agent (detected by `resolveTargetAgent()` in `src/main/transition-engine/agent-resolver.ts`), a cross-agent handoff occurs:

1. **Agent resolution** detects agent change: `resolveTargetAgent()` checks `task.agent_override` first (highest priority - the user's create-time lock), then column `agent_override`, then project `default_agent`, then global fallback (`'claude'`). If the resolved agent differs from the current session's agent, a handoff is triggered. Tasks with a non-null `task.agent_override` never trigger a handoff on column moves - the locked agent supersedes column settings.
2. **Task-move Priority 3** suspends the current session.
3. **spawnAgent handoff path** - the `agentOverride` parameter is passed to `executeSpawnAgent()`, which prevents resume of the wrong agent's session.
4. **HandoffOrchestrator** packages context from the previous session: transcript (from `session_transcripts`), git diff, and session metrics.
5. **Transition engine** spawns the new agent with a `handoffPromptPrefix` that summarizes the handoff context.
6. **Post-spawn** - a `handoff-context.md` file is written to the session directory for the new agent to reference.

Spawn progress phases during handoff: `packaging-handoff` (while context is being assembled), `detecting-agent` (while the target agent CLI is detected), then `starting-agent`.

Because create-into-spawn-column and unarchive route through the same `spawnAgent` chokepoint as task moves, handoff semantics apply on those paths too: unarchiving a task into a column whose resolved agent differs from `task.agent` packages handoff context when the column's `handoff_context` toggle is enabled, and spawns the new agent fresh (no context) when it is disabled. The full entry-point table lives in [Session Lifecycle](session-lifecycle.md#spawn-entry-points).

## See Also

- [Session Lifecycle](session-lifecycle.md) -- spawn entry points, spawn flow, queue, suspend, resume
- [Agent Integration](agent-integration.md) -- command building, permission modes, per-agent CLI details
- [Worktree Strategy](worktree-strategy.md) -- worktree creation details
- [Database](database.md) -- schema for `column_automations`, `automation_runs`, swimlanes
- [Configuration](configuration.md#column-automations) -- the `kangentic.json` shape for a column's lists
