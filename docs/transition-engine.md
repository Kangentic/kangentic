# Transition Engine

`src/main/engine/transition-engine.ts`

The transition engine executes action chains when tasks move between swimlanes. It handles the logic that makes Kanban columns "active" -- spawning agents, sending commands, managing worktrees, and more.

## Priority Rules on Task Move

When a task moves from one column to another, the IPC handler (`task:move`) checks these conditions in order. The first match wins:

| Priority | Condition | Action |
|----------|-----------|--------|
| 1 | Target is **Backlog** (role=`backlog`) | Kill session, preserve worktree |
| 2 | Target is **Done** (role=`done`) | Suspend session (resumable), archive task |
| 3 | Target has `auto_spawn=false` | Suspend session |
| 4 | Task has **active session** | Keep session alive. If target has `auto_command`, inject it via CommandInjector |
| 5 | Task has **no session** | Resume suspended session OR create worktree (if enabled) + execute transition action chain |

Transition action chains (case 5) only fire when a task has no active session. This means moving between active columns with a running agent simply keeps the agent running -- no restart, no context loss.

## Transition Lookup

Transitions are stored in the `swimlane_transitions` table with `from_swimlane_id` and `to_swimlane_id`.

Lookup order:
1. **Exact match** -- `from_swimlane_id = <source>` AND `to_swimlane_id = <target>`
2. **Wildcard source** -- `from_swimlane_id = '*'` AND `to_swimlane_id = <target>`

The wildcard `*` source is the common case. It means "from any column into this target." Most projects use wildcard transitions exclusively.

## Action Chain

When a transition fires, its actions execute sequentially in `execution_order`:

```
transition fires
  → action_0 (execution_order: 0) -- e.g., kill_session
  → action_1 (execution_order: 1) -- e.g., spawn_agent
  → action_2 (execution_order: 2) -- e.g., send_command
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
| `permissionMode` | PermissionMode | Override permission mode for this action |
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
| `{{attachments}}` | ` [Review images: path1, path2]` when present |

## Command Injection

When a task with a running session moves to a column that has `auto_command` set (priority 4), the command is injected into the running PTY:

1. `CommandInjector` retrieves the session for the task
2. Interpolates the `auto_command` template with task variables
3. Sanitizes for PTY safety
4. Writes to PTY stdin with `\r` terminator

This enables workflows like moving a task from "Running" to "Code Review" to automatically send a review prompt to the agent.

## Swimlane Roles

Two special roles affect behavior:

| Role | Behavior |
|------|----------|
| `backlog` | Task moves here → session killed (not suspended), worktree preserved |
| `done` | Task moves here → session suspended (resumable), task archived |

All other columns (including Planning, Running, Code Review, etc.) are custom columns with no special role. Their behavior is controlled by `auto_spawn`, `auto_command`, `permission_strategy`, and `plan_exit_target_id`.

## auto_spawn Flag

Each swimlane has an `auto_spawn` boolean (default: `true`):
- `true` -- tasks in this column should have active sessions. Session recovery and reconciliation will spawn agents here.
- `false` -- tasks in this column should NOT have active sessions. Moving a task here suspends its session.

Backlog and Done columns have `auto_spawn=false` by default.

## plan_exit_target_id

When a column has `permission_strategy='plan'`, Claude runs in plan mode. When the agent completes planning and fires `ExitPlanMode`, Kangentic detects this via the event bridge and automatically moves the task to the column specified by `plan_exit_target_id`.

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
