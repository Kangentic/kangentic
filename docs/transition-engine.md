# Transition Engine

`src/main/transition-engine/transition-engine.ts`

The transition engine executes action chains when tasks move between swimlanes. It handles the logic that makes Kanban columns "active" -- spawning agents, sending commands, managing worktrees, and more.

## Priority Rules on Task Move

When a task moves from one column to another, the IPC handler (`task:move`) checks these conditions in order. The first match wins:

| Priority | Condition | Action |
|----------|-----------|--------|
| 1 | Target is **To Do** (role=`todo`) | Kill session, preserve worktree |
| 2 | Target is **Done** (role=`done`) | Suspend session (resumable), archive task |
| 2.5 | Target has `auto_spawn=false` (non-todo, non-done) | Suspend session |
| 3 | Task has **active session** | Permission-mode delta suspends and respawns with the destination's CLI flags. Live injection plan injects into the running session. Model/effort delta without live-swap suspends and respawns. Otherwise keep alive. |
| 4 | Task has **no session** | Resume suspended session (with `auto_command` preloaded as resume prompt) OR create worktree (if enabled) + execute transition action chain |

### Priority 3: Active Session Handling

Priority 3 has five sub-cases, checked in order:

**a) Agent change (handoff):** If `resolveTargetAgent()` returns a different agent than the current session's agent, the session is suspended and the engine falls through to the `spawnAgent` path. The `agentOverride` parameter is set on the spawn request to prevent the new session from resuming the old agent's session. **Side effect:** per-task `model_override` and `effort_override` are cleared on handoff because override values are model-name-specific and don't carry across agents (Claude's `claude-sonnet-4-6` is meaningless to Codex). This clear is skipped when `task.agent_override` is set, since the user locked the agent at creation and the overrides remain valid for that agent. If the target column has `handoff_context` enabled, prior work context (transcript, git diff, metrics) is packaged and delivered to the new agent. If disabled (the default), the new agent starts fresh with just the task title/description. See [Cross-Agent Handoff](#cross-agent-handoff) below.

**b) Same agent + permission-mode delta:** If the destination column's EFFECTIVE permission mode (`lane.permission_mode ?? config.agent.permissionMode`) differs from the mode the live session was spawned with (the session record's `permission_mode`, not the source lane), the session is suspended and respawned. No adapter exposes a non-interactive permission-mode switch for a live session (Claude's only mechanism is interactive shift+tab cycling), so this is checked before live injection. The respawn resumes the same agent session id, and the destination's `--permission-mode` / `--model` / `--effort` land as CLI flags. Legacy session records with a null `permission_mode` never trigger this case. A plan-exit auto-move additionally passes a continuation prompt ("Your plan was approved. Proceed with the implementation.") delivered as the resumed session's first message when the destination column has no `auto_command` (the `auto_command` wins when present).

**c) Same agent + live injection plan:** If the destination adapter returns a non-null plan from `prepareInjectionPlan` (model/effort slash commands like `/model X` + optional auto_command), the writes are scheduled directly into the running session via `TerminalSubmitScheduler.scheduleKeystrokes`. No suspend/resume cycle occurs. The delta is computed against what the session is *actually running at*, not the leaving column, so a column whose value the session already has injects nothing. The two fields resolve that differently: **model** uses the session record's `applied_model`, while **effort** prefers the level the agent itself reports (`task.effort_override ?? <agent-reported effort> ?? record.applied_effort`), because `applied_effort` records only what Kangentic last asked for and an `/effort` typed straight into the terminal never reaches it. Model deliberately stays record-only - telemetry reports canonical ids while the configured values are flag strings, so comparing them would read a false change and restart the PTY. See [Command Injection](command-injection.md) for the full precedence. After scheduling, when `plan.appliedSettings` is present the handler persists it via `sessionRepo.updateAppliedSettings`, keeping the recorded value current so the next move diffs against the truth.

**d) Same agent + concrete model/effort delta (no live-swap):** If the adapter has no live-swap slash for the target value AND the destination column overrides model or effort to a non-null value the session is not already running at (the delta is computed against what the session is actually running at, not the source lane: `applied_model` for model, and `task.effort_override ?? <agent-reported effort> ?? record.applied_effort` for effort, matching case (c) above), the session is suspended and respawned so the new flags land on the command line. The respawn is skipped when the target value is null (entering a "Default" column) because adapters have no `/model <agent-default>` slash and `--resume <id>` preserves the saved model regardless - the suspend/resume would just churn the PTY without changing anything. Matches the recovery contract in `task-runtime-override.ts`.

**e) Same agent, no delta or no concrete target:** The session stays alive with no interruption.

Transition action chains (priority 4) only fire when a task has no active session.

## Transition Lookup

Transitions are stored in the `swimlane_transitions` table with `from_swimlane_id` and `to_swimlane_id`.

Lookup order:
1. **Exact match** -- `from_swimlane_id = <source>` AND `to_swimlane_id = <target>`
2. **Wildcard source** -- `from_swimlane_id = '*'` AND `to_swimlane_id = <target>`

The wildcard `*` source is the common case. It means "from any column into this target." Most projects use wildcard transitions exclusively.

## Action Chain

A single transition lookup (`from_swimlane_id` + `to_swimlane_id`) returns multiple `swimlane_transitions` records, each pointing to one action via `action_id`. These records are ordered by `execution_order` and executed sequentially:

```
transition lookup (from → to)
  → swimlane_transitions[0] → action_id → kill_session  (execution_order: 0)
  → swimlane_transitions[1] → action_id → spawn_agent   (execution_order: 1)
  → swimlane_transitions[2] → action_id → send_command   (execution_order: 2)
```

Each action is a record in the `actions` table with a `type` and `config_json`.

## Action Types

### `spawn_agent`

Builds a Claude CLI command and spawns a PTY session. If a suspended session exists for the task, resumes it instead.

Config:
| Field | Type | Description |
|-------|------|-------------|
| `agent` | string | Agent identifier (default: `'claude'`) |
| `promptTemplate` | string | Template with `{{placeholders}}` |
| `nonInteractive` | boolean | Use `--print` mode (run and exit) |

### `send_command`

Writes interpolated text to the running PTY stdin. Used for injecting commands into an active Claude session.

Config:
| Field | Type | Description |
|-------|------|-------------|
| `command` | string | Text to send (supports `{{placeholders}}`) |

The command is sanitized for PTY safety and terminated with `\r` (Enter).

### `run_script`

Spawns a one-off shell command in a new PTY session. Not persisted for resume.

Config:
| Field | Type | Description |
|-------|------|-------------|
| `script` | string | Shell command to run (supports `{{placeholders}}`) |
| `workingDir` | `'worktree'` \| `'project'` | CWD for the script |

### `kill_session`

Suspends the session (marks as `suspended` in DB for resume capability), kills the PTY, and clears `task.session_id`.

Config: `{}` (no configuration needed)

Despite the name, `kill_session` actually performs a **suspend** -- the Claude conversation ID is preserved so the session can be resumed later. This enables workflows like "Planning → Running" where Planning kills the old session but Running's `spawn_agent` picks it up with `--resume`.

### `create_worktree`

Creates a git worktree for the task with sparse-checkout.

Config:
| Field | Type | Description |
|-------|------|-------------|
| `baseBranch` | string | Override base branch (default: `config.git.defaultBaseBranch`) |
| `copyFiles` | string[] | Files to copy from repo root (default: `config.git.copyFiles`) |

See [Worktree Strategy](worktree-strategy.md) for full details.

### `cleanup_worktree`

Removes the task's worktree directory and optionally deletes the branch (if `config.git.autoCleanup` is true).

Config: `{}` (no configuration needed)

### `create_pr`

Reserved action type. Not yet implemented.

### `webhook`

POSTs to a URL with an interpolated body.

Config:
| Field | Type | Description |
|-------|------|-------------|
| `url` | string | Target URL (supports `{{placeholders}}`) |
| `method` | `'GET'` \| `'POST'` \| `'PUT'` | HTTP method (default: `POST`) |
| `body` | string | Request body (supports `{{placeholders}}`) |
| `headers` | Record<string, string> | Additional headers |

Content-Type defaults to `application/json`. Failures are logged but don't block the action chain.

## Template Variables

One declaration (`src/shared/task-template-vars.ts`) drives every consumer: the
`auto_command` field (column and per-task), the `spawn_agent` action's
`promptTemplate`, the Automation section's "Template variable" picker, and this
table - see `tests/unit/task-template-vars-parity.test.ts`. Because the picker
shows each entry's `description`, that field is user-facing copy and should stay
to one line. All 10 keywords resolve
identically in both `auto_command` and `promptTemplate`; `send_command` /
`run_script` / `webhook` use the same values but keep literal, non-collapsing
substitution (an unknown or empty `{{key}}` is left as-is, matching
`interpolateTemplate`'s general behavior).

| Variable | Value |
|----------|-------|
| `{{title}}` | Task title (PTY-sanitized) |
| `{{description}}` | Task description with `: ` prefix when non-empty |
| `{{task_xml}}` | Task title and description wrapped in a `<task>` envelope (`<title>` / `<description>` children). Default seeded prompt template is `{{task_xml}}{{attachments}}`, which gives the agent a structured envelope without forcing the user to template it manually. |
| `{{taskId}}` | Task UUID |
| `{{worktreePath}}` | Worktree directory path (empty if none) - a raw read, never falls back to a project-level path |
| `{{branchName}}` | Git branch name (empty if none) - a raw read, never falls back to a project-level branch |
| `{{baseBranch}}` | Effective base branch: the task's `base_branch` override, else the project's configured default (board config, then app config, then `'main'`) |
| `{{prUrl}}` | Pull request URL (empty if none) |
| `{{prNumber}}` | Pull request number as string (empty if none) |
| `{{attachments}}` | Bare file paths (one per line) when present |
| `{{port}}` | Lowest dev-server port this task has RESERVED (empty if none, which is the normal state) - a raw read, never falls back to another task's port |

In `auto_command` and `promptTemplate` specifically, an empty-valued or unknown
`{{key}}` is dropped and surrounding horizontal whitespace collapses (newlines
are preserved), so `/code-review {{baseBranch}}` with no configured default
still yields `/code-review`, not a trailing space or a literal placeholder.

Note what that means for a FLAG-shaped placeholder: `--port {{port}}` with no
reservation collapses to a bare `--port`, which most CLIs reject.

That matters more than it used to, because Kangentic reserves NOTHING up front.
A port exists for a task only once its agent asked for one
(`kangentic_reserve_dev_ports`), so empty is the normal state, not the edge
case. A column `auto_command` shared by every task in a column therefore should
not template `{{port}}` in - most of those tasks hold no reservation. Prefer
letting the agent reserve the ports it is about to bind and use them directly;
reach for `{{port}}` only where the task is known to hold one.

Shortcut commands use a separate set of template variables. See [Configuration](configuration.md#shortcuts) for the full list.

## Stale Spawn Prevention (AbortSignal)

When a task moves rapidly between columns (e.g. user drags to the wrong column and immediately corrects), earlier transitions may still be in-flight when the new transition starts. Without cancellation, the old spawn would complete and create a PTY process that the new transition immediately supersedes.

The transition engine threads an `AbortSignal` through the execution chain:

- `executeTransition()` checks the signal before each action in the chain
- `executeAction()` checks the signal before dispatching to the action handler
- `executeSpawnAgent()` checks the signal as a final gate before creating the PTY process

If the signal is aborted, the method throws an `AbortError` which the caller catches and ignores (the newer transition takes over). This prevents orphaned PTY processes from accumulating.

## Command Injection

When a task moves to a column with `auto_command` set, the command delivery depends on how the session was started:

**Resumed sessions** (priority 3 suspend-and-resume, or priority 4 resume from suspended):
- The `auto_command` is interpolated and passed as the resume prompt to `claude --resume <id>`
- This is deterministic: the command is the first thing the agent sees on resume

**Fresh spawns** (priority 4, no suspended session to resume):
- `TerminalSubmitScheduler.scheduleKeystrokes` schedules the command for deferred PTY injection
- Interpolates the `auto_command` template with task variables
- Waits for the CLI's first `'thinking'` activity event, then delivers via `TerminalSubmit.submitKeystrokes` as a handshake chain (drain + output-settle between keystrokes) rather than fixed sleeps

If keystroke delivery cannot be confirmed in the agent's transcript, it escalates to a session restart that passes the command as the CLI's prompt argument - the same guarantee the resumed path has. Every injection ends in a recorded outcome on the task, and a failure raises a notice instead of a console warning. The full contract, including the delivery ladder, the prompt-state policy, and the measured before/after delivery rate, is in [Command Injection](command-injection.md).

A column also declares WHEN its command fires, via `auto_command_mode`: `immediate` (the default; interrupts the agent's current turn if there is one) or `deferred` (holds until that turn genuinely finishes). "Finishes" requires activity `idle` AND a quiet PTY, because a bare idle is reported for minutes during an API retry backoff or a `Monitor` wait.

This enables workflows like moving a task from "Running" to "Code Review" to automatically send a review prompt to the agent.

A per-task `auto_command` (MCP-only, `kangentic_create_task`'s `autoCommand` param) wins over the column's for that task. The unarchive handlers (`TASK_UNARCHIVE` / `TASK_BULK_UNARCHIVE`) and any other move out of Done suppress injection entirely via `spawnAgent`'s `suppressAutoCommand` (the recovery-move contract; see [Session Lifecycle](session-lifecycle.md#resume)).

When a `spawn_agent` transition action creates the session itself (a custom action wired onto the entry transition), that action's own prompt template runs and the fallback `auto_command` / continuation injection is skipped for that spawn. This is uniform across every entry point (move, create, promote, MCP create), since all route through `spawnAgent`, whose fallback delivery only fires when no action spawned the session. The default board is unaffected: its one action-backed column (Planning) has no `auto_command`.

## Swimlane Roles

Two special roles affect behavior:

| Role | Behavior |
|------|----------|
| `todo` | Task moves here → session killed (not suspended), worktree preserved |
| `done` | Task moves here → session suspended (resumable), task archived |

All other columns (including Planning, Executing, Code Review, etc.) are custom columns with no special role. Their behavior is controlled by `auto_spawn`, `auto_command`, `permission_mode`, and `plan_exit_target_id`.

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

New projects get:
- **Start Planning Agent** action (`spawn_agent` with template `{{task_xml}}{{attachments}}`)
- **Kill Session** action (`kill_session`)
- Transition: `* → Planning` = Kill Session (order 0), Start Planning Agent (order 1)
- Transition: `* → Done` = Kill Session (order 0)

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
- [Database](database.md) -- schema for actions, transitions, swimlanes
