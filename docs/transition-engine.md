# Transition Engine

`src/main/engine/transition-engine.ts`

The transition engine executes action chains when tasks move between swimlanes. It handles the logic that makes Kanban columns "active" -- spawning agents, sending commands, managing worktrees, and more.

## Priority Rules on Task Move

When a task moves from one column to another, the IPC handler (`task:move`) checks these conditions in order. The first match wins:

| Priority | Condition | Action |
|----------|-----------|--------|
| 1 | Target is **To Do** (role=`todo`) | Kill session, preserve worktree |
| 2 | Target is **Done** (role=`done`) | Suspend session (resumable), archive task |
| 2.5 | Target has `auto_spawn=false` (non-todo, non-done) | Suspend session |
| 3 | Task has **active session** | If target has `auto_command`, suspend and respawn with command as resume prompt. Otherwise keep alive (permission mode differences alone do not trigger suspend/resume). |
| 4 | Task has **no session** | Resume suspended session (with `auto_command` preloaded as resume prompt) OR create worktree (if enabled) + execute transition action chain |

### Priority 3: Permission Mode Guard

When a task with an active session moves to a column that has an `auto_command` configured, the session is suspended and resumed with the command as the resume prompt. During this transition, a shimmer overlay appears in the terminal UI while the new session starts.

Permission mode differences alone do not trigger suspend/resume. If the target column has no `auto_command`, the session stays alive with no interruption regardless of permission mode.

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

All action types that accept templates can use these placeholders:

| Variable | Value |
|----------|-------|
| `{{title}}` | Task title (PTY-sanitized) |
| `{{description}}` | Task description with `: ` prefix when non-empty |
| `{{taskId}}` | Task UUID |
| `{{worktreePath}}` | Worktree directory path (empty if none) |
| `{{branchName}}` | Git branch name (empty if none) |
| `{{prUrl}}` | Pull request URL (empty if none) |
| `{{prNumber}}` | Pull request number as string (empty if none) |
| `{{attachments}}` | Bare file paths (one per line) when present |

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
- `CommandInjector` schedules the command for deferred PTY injection
- Interpolates the `auto_command` template with task variables
- Writes to PTY stdin with `\r` terminator after the session is ready

This enables workflows like moving a task from "Running" to "Code Review" to automatically send a review prompt to the agent.

## Swimlane Roles

Two special roles affect behavior:

| Role | Behavior |
|------|----------|
| `todo` | Task moves here → session killed (not suspended), worktree preserved |
| `done` | Task moves here → session suspended (resumable), task archived |

All other columns (including Planning, Running, Code Review, etc.) are custom columns with no special role. Their behavior is controlled by `auto_spawn`, `auto_command`, `permission_mode`, and `plan_exit_target_id`.

## auto_spawn Flag

Each swimlane has an `auto_spawn` boolean (default: `true`):
- `true` -- tasks in this column should have active sessions. Session recovery and reconciliation will spawn agents here.
- `false` -- tasks in this column should NOT have active sessions. Moving a task here suspends its session.

To Do and Done columns have `auto_spawn=false` by default.

## plan_exit_target_id

When a column has `permission_mode='plan'`, Claude runs in plan mode. When the agent completes planning and fires `ExitPlanMode`, Kangentic detects this via the event bridge and automatically moves the task to the column specified by `plan_exit_target_id`.

Default setup: Planning column has `plan_exit_target_id` pointing to the Executing column.

## Default Seed Configuration

New projects get:
- **Start Planning Agent** action (`spawn_agent` with template `{{title}}{{description}}{{attachments}}`)
- **Kill Session** action (`kill_session`)
- Transition: `* → Planning` = Kill Session (order 0), Start Planning Agent (order 1)
- Transition: `* → Done` = Kill Session (order 0)

## See Also

- [Session Lifecycle](session-lifecycle.md) -- spawn flow, queue, suspend, resume
- [Claude Integration](claude-integration.md) -- command building, permission modes
- [Worktree Strategy](worktree-strategy.md) -- worktree creation details
- [Database](database.md) -- schema for actions, transitions, swimlanes
